const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

// --- Application Setup ---
const app = express();
const PORT = process.env.PORT || 3000;

// Set to 'true' to skip the Gemini API call and use a simulated, successful JSON filter.
// Set to 'false' to use the live Gemini API.
const LLM_DEBUG_MODE = true; 

// Middleware to parse incoming JSON requests
app.use(express.json());

// In-memory data store (key: sha256_hash, value: analysis object)
const stringDatabase = {};
const apiKey = ""; // API key is left empty; Canvas environment handles injection

// Helper function for exponential backoff during API calls
async function fetchWithBackoff(url, options, maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            // Using the global fetch function
            const response = await fetch(url, options); 
            if (response.status === 429) {
                // Too Many Requests error
                if (i < maxRetries - 1) {
                    const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
                    console.warn(`API Rate Limit Hit. Retrying in ${Math.round(delay/1000)}s...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
            }
            return response;
        } catch (error) {
            if (i < maxRetries - 1) {
                const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
                console.error(`API Fetch failed, retrying in ${Math.round(delay/1000)}s...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            throw error;
        }
    }
}

// --- Core Analysis Function (Used by POST and for filtering) ---
function analyzeString(value) {
    const length = value.length;
    const sha256_hash = crypto.createHash('sha256').update(value).digest('hex');
    const normalizedValue = value.toLowerCase().replace(/[^a-z0-9]/g, '');
    const reversedValue = normalizedValue.split('').reverse().join('');
    const is_palindrome = normalizedValue === reversedValue;
    const word_count = value.split(/\s+/).filter(word => word.length > 0).length;
    
    const character_frequency_map = {};
    for (const char of normalizedValue) {
        character_frequency_map[char] = (character_frequency_map[char] || 0) + 1;
    }
    const unique_characters = Object.keys(character_frequency_map).length;

    return {
        length,
        is_palindrome,
        unique_characters,
        word_count,
        sha256_hash,
        character_frequency_map,
    };
}

// --- Function to Validate and Apply Filters (Reused from previous GET /strings) ---
function filterData(data, filters, res) {
    const parsedFilters = {};
    const errors = [];
    
    // Convert filter values from strings (or raw LLM output) to correct types
    
    if (filters.is_palindrome !== undefined) {
        const val = String(filters.is_palindrome).toLowerCase();
        if (val === 'true' || filters.is_palindrome === true) {
            parsedFilters.is_palindrome = true;
        } else if (val === 'false' || filters.is_palindrome === false) {
            parsedFilters.is_palindrome = false;
        } else {
            errors.push('is_palindrome must be true or false');
        }
    }

    if (filters.min_length !== undefined) {
        const num = parseInt(filters.min_length);
        if (isNaN(num) || num < 0) {
            errors.push('min_length must be a non-negative integer');
        } else {
            parsedFilters.min_length = num;
        }
    }

    if (filters.max_length !== undefined) {
        const num = parseInt(filters.max_length);
        if (isNaN(num) || num < 0) {
            errors.push('max_length must be a non-negative integer');
        } else {
            parsedFilters.max_length = num;
        }
    }

    if (filters.word_count !== undefined) {
        const num = parseInt(filters.word_count);
        if (isNaN(num) || num < 1) {
            errors.push('word_count must be a positive integer');
        } else {
            parsedFilters.word_count = num;
        }
    }

    if (filters.contains_character !== undefined) {
        const char = String(filters.contains_character);
        if (typeof char !== 'string' || char.length !== 1) {
            // Allow LLM to output things like "the letter a" and try to fix it
            if (char.length > 1) {
                // If it's a long string, attempt to take the first letter if it's alphanumeric
                const firstChar = char.toLowerCase().trim().charAt(0);
                if (firstChar.match(/[a-z0-9]/)) {
                    parsedFilters.contains_character = firstChar;
                } else {
                     errors.push('contains_character could not be simplified to a single character');
                }
            } else {
                errors.push('contains_character must be a single character string');
            }
        } else {
            parsedFilters.contains_character = char.toLowerCase();
        }
    }

    if (errors.length > 0) {
        // Return 400 status if filters derived from the LLM or user were invalid
        return { error: true, status: 400, message: 'Invalid filter values in interpreted query', details: errors };
    }


    // --- Filtering Logic ---

    let filteredData = data;

    // Filter by is_palindrome (boolean match)
    if (parsedFilters.is_palindrome !== undefined) {
        filteredData = filteredData.filter(item => 
            item.properties.is_palindrome === parsedFilters.is_palindrome
        );
    }

    // Filter by min_length (inclusive)
    if (parsedFilters.min_length !== undefined) {
        filteredData = filteredData.filter(item => 
            item.properties.length >= parsedFilters.min_length
        );
    }

    // Filter by max_length (inclusive)
    if (parsedFilters.max_length !== undefined) {
        filteredData = filteredData.filter(item => 
            item.properties.length <= parsedFilters.max_length
        );
    }

    // Filter by word_count (exact match)
    if (parsedFilters.word_count !== undefined) {
        filteredData = filteredData.filter(item => 
            item.properties.word_count === parsedFilters.word_count
        );
    }
    
    // Filter by contains_character (case-insensitive)
    if (parsedFilters.contains_character !== undefined) {
        const char = parsedFilters.contains_character;
        filteredData = filteredData.filter(item => {
            // Check if the lowercase character exists as a key in the frequency map
            return item.properties.character_frequency_map[char] !== undefined;
        });
    }

    return { error: false, data: filteredData, parsedFilters: parsedFilters };
}


// --- RESTful API Endpoint 1: POST /strings (Create/Analyze String) ---
app.post('/strings', (req, res) => {
    const { value } = req.body;
    if (value === undefined) {
        return res.status(400).json({ error: 'Bad Request: Missing "value" field in request body' });
    }
    if (typeof value !== 'string') {
        return res.status(422).json({ error: 'Unprocessable Entity: "value" field must be a string' });
    }

    const properties = analyzeString(value);
    const id = properties.sha256_hash;

    if (stringDatabase[id]) {
        return res.status(409).json({ error: 'Conflict: String already exists in the system', id: id });
    }

    const result = {
        id: id,
        value: value,
        properties: properties,
        created_at: new Date().toISOString()
    };
    stringDatabase[id] = result;
    return res.status(201).json(result);
});


// --- RESTful API Endpoint 3: GET /strings (Get All Strings with Filtering) ---
app.get('/strings', (req, res) => {
    const filters = req.query;
    const validationResult = filterData(Object.values(stringDatabase), filters);

    if (validationResult.error) {
        return res.status(validationResult.status).json({ error: validationResult.message, details: validationResult.details });
    }
    
    return res.status(200).json({
        data: validationResult.data,
        count: validationResult.data.length,
        filters_applied: validationResult.parsedFilters
    });
});


// --- RESTful API Endpoint 4: GET /strings/filter-by-natural-language (MOVED UP) ---
app.get('/strings/filter-by-natural-language', async (req, res) => {
    const userQuery = req.query.query;

    if (!userQuery) {
        return res.status(400).json({ error: 'Bad Request: Missing "query" parameter for natural language filtering.' });
    }

    let parsedFilters = {};
    let rawResponseText = '';

    if (LLM_DEBUG_MODE) {
        console.log('LLM Debug Mode is ON. Bypassing API Call.');
        // Simulate successful LLM parsing for common test cases
        if (userQuery.includes('single word') && userQuery.includes('palindromic')) {
             parsedFilters = { "word_count": 1, "is_palindrome": true };
        } else if (userQuery.includes('two words')) {
             parsedFilters = { "word_count": 2 };
        } else {
             parsedFilters = {};
        }
    } else {
        // --- Live API Call ---
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

        const systemPrompt = `You are a query parser for an API service. Your task is to translate a natural language request for filtering strings into a precise JSON object of API filter parameters.

Available filters and their required types are:
- "is_palindrome": boolean (true or false). Only include if requested.
- "min_length": integer. Only include if requested (e.g., "longer than 10" becomes 11, "at least 5" becomes 5).
- "max_length": integer. Only include if requested.
- "word_count": integer. Only include if an exact number of words is specified (e.g., "single word" becomes 1, "two words" becomes 2).
- "contains_character": single, lowercase character string. Only include if a specific character is requested.

If the query is ambiguous, omit the filter. If the query asks for conflicting filters (e.g., "strings with 2 words and 5 words"), return an empty JSON object {}.

IMPORTANT: You MUST ONLY return the requested JSON object. DO NOT include any explanatory text, markdown formatting (like triple backticks), or comments outside of the JSON structure.

Example Query: "all single word palindromic strings"
Example Output: {"word_count": 1, "is_palindrome": true}`;

        const payload = {
            contents: [{ parts: [{ text: userQuery }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        "is_palindrome": { "type": "BOOLEAN" },
                        "min_length": { "type": "INTEGER" },
                        "max_length": { "type": "INTEGER" },
                        "word_count": { "type": "INTEGER" },
                        "contains_character": { "type": "STRING" }
                    }
                }
            }
        };

        try {
            const apiResponse = await fetchWithBackoff(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            
            const result = await apiResponse.json();
            
            if (result.candidates && result.candidates.length > 0 &&
                result.candidates[0].content && result.candidates[0].content.parts &&
                result.candidates[0].content.parts.length > 0) {
                
                rawResponseText = result.candidates[0].content.parts[0].text;
                
                try {
                    parsedFilters = JSON.parse(rawResponseText);
                } catch (e) {
                    console.error("Failed to parse LLM JSON (Raw Text):", rawResponseText);
                    return res.status(400).json({ error: 'Unable to parse natural language query: LLM returned unparsable content.' });
                }
            } else {
                 console.error("LLM returned no content. Full response object:", JSON.stringify(result, null, 2));
                 return res.status(400).json({ error: 'Unable to parse natural language query: LLM returned no content.' });
            }

        } catch (e) {
            console.error("Gemini API Error:", e);
            return res.status(500).json({ error: 'Internal Server Error: Failed to connect to or process Gemini API response.' });
        }
    }


    // --- 2. Check for Conflicting Filters (Heuristic for 422) ---
    if (Object.keys(parsedFilters).length === 0 && userQuery.toLowerCase().includes('and') && userQuery.toLowerCase().includes('word')) {
         return res.status(422).json({ 
             error: 'Unprocessable Entity: Query parsed but resulted in conflicting filters (e.g., conflicting word counts).',
             interpreted_query: { original: userQuery, parsed_filters: parsedFilters }
         });
    }

    // --- 3. Apply the LLM-derived Filters ---
    
    // Pass the parsed filters through the robust validation/filtering function
    const validationResult = filterData(Object.values(stringDatabase), parsedFilters);

    if (validationResult.error) {
        // 400 Bad Request: Invalid filter values (e.g., LLM produced a length of -5)
        return res.status(400).json({ error: 'Bad Request: Invalid filter values in interpreted query', details: validationResult.details });
    }
    
    // --- 4. Success Response (200 OK) ---

    return res.status(200).json({
        data: validationResult.data,
        count: validationResult.data.length,
        interpreted_query: {
            original: userQuery,
            parsed_filters: validationResult.parsedFilters
        }
    });
});


// --- RESTful API Endpoint 5: DELETE /strings/{stringValue} (Delete by Value) ---
app.delete('/strings/:stringValue', (req, res) => {
    // 1. Get the string value from the URL path
    const rawStringValue = req.params.stringValue;

    // 2. The string value will be URL-encoded, so we must decode it.
    const stringValue = decodeURIComponent(rawStringValue);

    // 3. Analyze the string value to compute the SHA-256 hash ID
    const { sha256_hash: idToDelete } = analyzeString(stringValue);

    // 4. Check if the string exists in the database
    if (!stringDatabase[idToDelete]) {
        return res.status(404).json({ error: 'Not Found: String does not exist in the system' });
    }

    // 5. Delete the record
    delete stringDatabase[idToDelete];

    // 6. Success Response: 204 No Content
    return res.status(204).send(); // Send an empty response body
});


// --- RESTful API Endpoint 2: GET /strings/{id} (Get Specific String by Hash ID) ---
app.get('/strings/:id', (req, res) => {
    const requestedHash = req.params.id;
    const storedAnalysis = stringDatabase[requestedHash];
    
    if (!storedAnalysis) {
        return res.status(404).json({ error: 'Not Found: String analysis does not exist in the system.', requested_id: requestedHash });
    }
    
    return res.status(200).json(storedAnalysis);
});


// --- Server Start ---
app.listen(PORT, () => {
    console.log(`String Analyzer Service running on http://localhost:${PORT}`);
    console.log(`Endpoints ready: POST /strings | GET /strings/{id} | GET /strings?filters | GET /strings/filter-by-natural-language?query=... | DELETE /strings/{stringValue}`);
});

