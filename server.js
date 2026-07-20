import express from 'express';
import { GoogleGenAI, Type } from '@google/genai';
import { initDatabase, getDbConnection } from './database.js';
import 'dotenv/config'; // Automatically loads your .env file!

const app = express();
const PORT = process.env.PORT || 4000; // 👈 FIX 1: Allow Render to choose the port

app.use(express.json({ limit: '12mb' }));
app.use(express.static('public'));

const apiKey = process.env.GEMINI_API_KEY || "";
console.log(`🔑 Checking API Key: Starts with: ${apiKey.slice(0, 6)}...`);

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: apiKey });

initDatabase().then(() => {
    console.log("📂 Local SQLite kitchen database ready.");
}).catch(err => {
    console.error("❌ Error initializing kitchen DB:", err);
});

// GET: All pantry inventory
app.get('/api/pantry', async (req, res) => {
    try {
        const db = await getDbConnection();
        const items = await db.all("SELECT * FROM pantry ORDER BY expiry_date ASC");
        res.json(items);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST: Log a new food item
app.post('/api/pantry', async (req, res) => {
    const { name, quantity, expiry_date, added_date, storage } = req.body;
    
    if (!name || !expiry_date) {
        return res.status(400).json({ error: "Missing product name or expiry target." });
    }
    
    try {
        const db = await getDbConnection();
        await db.run(
            `INSERT INTO pantry (name, quantity, expiry_date, added_date, storage) 
             VALUES (?, ?, ?, ?, ?)`,
            [
                name, 
                quantity || '1 count', 
                expiry_date, 
                added_date || new Date().toISOString().split('T')[0], 
                storage || 'Fridge'
            ]
        );
        res.status(201).json({ message: "Successfully logged item." });
    } catch (error) {
        try {
            const db = await getDbConnection();
            await db.run(
                "INSERT INTO pantry (name, quantity, expiry_date) VALUES (?, ?, ?)",
                [name, quantity || '1 count', expiry_date]
            );
            res.status(201).json({ message: "Successfully logged item (legacy columns fallback)." });
        } catch (fallbackError) {
            res.status(500).json({ error: fallbackError.message });
        }
    }
});

// 📸 POST: Analyze image with Gemini
app.post('/api/pantry/scan', async (req, res) => {
    const { image } = req.body;
    if (!image) {
        return res.status(400).json({ error: "No image payload received." });
    }

    try {
        const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
        console.log("🤖 Sending image to Gemini...");

        const response = await ai.models.generateContent({
            model: 'gemini-3.5-flash',
            contents: [
                {
                    inlineData: {
                        mimeType: 'image/jpeg',
                        data: base64Data
                    }
                },
                `You are KAI, an advanced kitchen assistant. Analyze this kitchen camera shot. 
                Identify:
                1. The name of the grocery or raw food item.
                2. The approximate quantity or pack volume.
                3. The expiration date. 
                
                CRITICAL INSTRUCTION: If no expiration date is physically printed or visible, estimate a highly realistic date counting forward from today's date (${new Date().toISOString().split('T')[0]}) using standard shelf-life guidelines.`
            ],
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            name: { type: Type.STRING },
                            quantity: { type: Type.STRING },
                            expiry_date: { type: Type.STRING }
                        },
                        required: ["name", "quantity", "expiry_date"]
                    }
                }
            }
        });

        const recognizedItems = JSON.parse(response.text);
        const db = await getDbConnection();
        for (const item of recognizedItems) {
            await db.run(
                "INSERT INTO pantry (name, quantity, expiry_date) VALUES (?, ?, ?)",
                [item.name, item.quantity, item.expiry_date]
            );
        }

        res.json({ success: true, items: recognizedItems });
    } catch (error) {
        console.error("AI Scan Error:", error);
        res.status(500).json({ error: "Failed to process image with AI: " + error.message });
    }
});

// 💬 POST: Chat with Contextual AI Agent
app.post('/api/chat', async (req, res) => {
    try {
        const { message, history, pantry } = req.body;

        // 1. Build a clean context string of the user's live inventory
        let pantryContext = "The user's pantry is currently completely empty.";
        if (pantry && pantry.length > 0) {
            pantryContext = "The user has the following items in their pantry right now:\n" + 
                pantry.map(item => `- ${item.name} (Quantity: ${item.quantity || 1}, Expires: ${item.expiry_date || 'N/A'}, ID: ${item.id})`).join('\n');
        }

        // 2. Define bulletproof instructions for KAI
        const systemInstruction = `You are KAI, a helpful, witty, and highly knowledgeable AI kitchen companion ("Kitchen AI").
        
        CRITICAL CONVERSATIONAL RULES:
        - Keep responses brief, snappy, text-style, and match the user's energy.
        - NEVER ask the user what ingredients they have. You have live database access.
        
        DYNAMIC CULINARY LOGIC (FUTURE-PROOF):
        Before writing the "steps" array, evaluate the physical state of every item used:
        
        1. NO-COOK / READY-TO-EAT INGREDIENTS:
           - If the ingredients are pre-packaged treats, snacks, dairy, fruits, raw vegetables, or ready-to-eat items (e.g., ice cream, cookies, chips, yogurt, berries, bread, nuts, deli meats), applying heat is strictly FORBIDDEN.
           - Instead, you MUST use physical preparation and assembly verbs: "Crush," "Chop," "Slice," "Dice," "Layer," "Dollop," "Drizzle," "Toss," "Chill," or "Assemble."
           - Make the instructions realistic to how a human handles snacks (e.g., crushing chips in a bag, dicing a cold bar, layering items in a glass).

        2. COOKED INGREDIENTS:
           - Only use heat verbs ("heat," "simmer," "boil," "fry") if the user is explicitly cooking raw foods that require heat to be edible (like raw meats, grains, eggs, pasta).

        INGREDIENT DEFICIT FLOW:
        If the user requests a meal or dish that their available pantry ingredients cannot plausibly support:
        1. Set "isRecipe" to false.
        2. Populate the "shoppingList" array with the specific, crucial items they need to buy.
        3. Populate the "pantryAlternative" object with a title and step-by-step assembly instructions for something they CAN make right now using only their live pantry items.`;

        const contextualizedUserMessage = `[SYSTEM NOTE: Live pantry database supplied] User's message: ${message}`;

        const contents = [];
        if (history && history.length > 0) {
            history.forEach(turn => {
                contents.push({
                    role: turn.role === "assistant" ? "model" : "user",
                    parts: [{ text: typeof turn.content === 'string' ? turn.content : JSON.stringify(turn.content) }]
                });
            });
        }
        
        contents.push({ role: "user", parts: [{ text: contextualizedUserMessage }] });

        // 3. Request Strict Structured JSON from Gemini using proper schema format
        const response = await ai.models.generateContent({
            model: "gemini-3.5-flash",
            contents: contents,
            config: {
                systemInstruction: systemInstruction, 
                temperature: 0.1, 
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        reply: { type: Type.STRING },
                        isRecipe: { type: Type.BOOLEAN },
                        recipeTitle: { type: Type.STRING },
                        usedIngredients: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    id: { type: Type.INTEGER },
                                    name: { type: Type.STRING }
                                },
                                required: ["id", "name"]
                            }
                        },
                        steps: {
                            type: Type.ARRAY,
                            items: { type: Type.STRING }
                        },
                        shoppingList: {
                            type: Type.ARRAY,
                            items: { type: Type.STRING }
                        },
                        pantryAlternative: {
                            type: Type.OBJECT,
                            properties: {
                                title: { type: Type.STRING },
                                steps: {
                                    type: Type.ARRAY,
                                    items: { type: Type.STRING }
                                }
                            },
                            required: ["title", "steps"]
                        }
                    },
                    required: ["reply", "isRecipe"]
                }
            }
        });

        const parsedResult = JSON.parse(response.text);

        // 4. Sanitize and Filter Ingredients to Prevent Duplicates
        const pantryNames = (pantry || []).map(p => (p.name || '').toLowerCase());
        let rawUsedIngredients = parsedResult.usedIngredients || [];

        const seenNames = new Set();
        let uniqueUsedIngredients = [];

        for (const item of rawUsedIngredients) {
            if (!item) continue;
            const itemName = typeof item === 'string' ? item : (item.name || '').toString();
            if (!itemName || seenNames.has(itemName.toLowerCase())) continue;
            
            seenNames.add(itemName.toLowerCase());
            uniqueUsedIngredients.push({
                name: itemName,
                id: typeof item === 'object' ? item.id : null
            });
        }

        const matched = uniqueUsedIngredients.filter(ui => pantryNames.some(pn => ui.name.toLowerCase().includes(pn) || pn.includes(ui.name.toLowerCase())));
        const minNeeded = Math.max(1, Math.ceil(uniqueUsedIngredients.length * 0.5));
        
        let finalIsRecipe = parsedResult.isRecipe === true && (matched.length >= minNeeded);

        // Map ingredients back to real database entry IDs
        const usedWithIds = uniqueUsedIngredients.map(ui => {
            const match = pantry.find(p => {
                const pn = (p.name || '').toLowerCase();
                return pn.includes(ui.name.toLowerCase()) || ui.name.toLowerCase().includes(pn);
            });
            return { id: match ? match.id : ui.id, name: ui.name };
        });

        const updatedHistory = [...history, { role: 'user', content: message }, { role: 'assistant', content: parsedResult.reply }];

        // 5. Send structured response back to frontend with safe fallback defaults
        res.json({
            reply: parsedResult.reply || "Here is what I found!",
            isRecipe: finalIsRecipe,
            recipeTitle: finalIsRecipe ? (parsedResult.recipeTitle || '') : '',
            usedIngredients: finalIsRecipe ? usedWithIds : [],
            steps: parsedResult.steps || [],
            shoppingList: parsedResult.shoppingList || [],
            pantryAlternative: parsedResult.pantryAlternative || null,
            history: updatedHistory
        });

    } catch (error) {
        console.error("❌ BACKEND CRASH ERROR LOG:", error.stack || error);

        const isQuotaError = (
            (error && (error.code === 429 || (error.error && error.error.code === 429))) ||
            (error && (error.status === 'RESOURCE_EXHAUSTED')) ||
            (error && error.message && error.message.toLowerCase().includes('quota'))
        );

        if (isQuotaError) {
            return res.status(429).json({ error: { message: 'AI quota exceeded. Please try again later or configure a different API key.' } });
        }

        res.status(503).json({ error: { message: `Service temporarily unavailable. Error: ${error.message}` } });
    }
});

// DELETE: Remove single item
app.delete('/api/pantry/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const db = await getDbConnection();
        await db.run("DELETE FROM pantry WHERE id = ?", [id]);
        res.json({ message: "Item removed from system." });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// BATCH-DELETE: Remove multiple items used in a recipe
app.post('/api/pantry/batch-delete', async (req, res) => {
    const { ids } = req.body; 
    if (!ids || !Array.isArray(ids)) {
        return res.status(400).json({ error: "Invalid or missing item IDs array." });
    }
    try {
        const db = await getDbConnection();
        for (const id of ids) {
            await db.run("DELETE FROM pantry WHERE id = ?", [id]);
        }
        res.json({ success: true, message: "Used ingredients cleared from inventory." });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET: All recipe history
app.get('/api/history', async (req, res) => {
    try {
        const db = await getDbConnection();
        const rows = await db.all("SELECT * FROM history ORDER BY cooked_date DESC, id DESC");
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST: Log history of a completed meal
app.post('/api/history', async (req, res) => {
    const { recipe_name, ingredients_used } = req.body;
    if (!recipe_name) return res.status(400).json({ error: "Missing recipe name." });
    
    try {
        const db = await getDbConnection();
        await db.run(
            "INSERT INTO history (recipe_name, ingredients_used) VALUES (?, ?)",
            [recipe_name, ingredients_used || '']
        );
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE: Remove a history record
app.delete('/api/history/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const db = await getDbConnection();
        await db.run("DELETE FROM history WHERE id = ?", [id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 👈 FIX 2: Removed duplicate getDbConnection import from here

// 📋 GET: Fetch all active shopping list items
app.get('/api/shopping-list', async (req, res) => {
    try {
        const db = await getDbConnection();
        const rows = await db.all(`SELECT * FROM shopping_list ORDER BY added_date DESC`);
        res.json(rows);
    } catch (err) {
        console.error("❌ Error fetching shopping list:", err);
        res.status(500).json({ error: err.message });
    }
});

// ➕ POST: Manually add a single item to the shopping list
app.post('/api/shopping-list', async (req, res) => {
    try {
        const { name, quantity } = req.body;
        if (!name) return res.status(400).json({ error: "Item name is required" });

        const db = await getDbConnection();
        const result = await db.run(
            `INSERT INTO shopping_list (name, quantity) VALUES (?, ?)`,
            [name, quantity || '1']
        );
        
        res.json({ id: result.lastID, name, quantity: quantity || '1' });
    } catch (err) {
        console.error("❌ Error adding item:", err);
        res.status(500).json({ error: err.message });
    }
});

// ⚡ POST: Batch add missing items generated by KAI's chat output
app.post('/api/shopping-list/batch', async (req, res) => {
    try {
        const { items } = req.body; 
        
        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: "No items provided to add" });
        }

        const db = await getDbConnection();
        
        const stmt = await db.prepare(`INSERT INTO shopping_list (name, quantity) VALUES (?, '1')`);
        for (const item of items) {
            await stmt.run([item]);
        }
        await stmt.finalize();
        
        res.json({ success: true, message: `Added ${items.length} items to your shopping list.` });
    } catch (err) {
        console.error("❌ Error batch-adding items:", err);
        res.status(500).json({ error: err.message });
    }
});

// ❌ DELETE: Remove an item when bought or cleared
app.delete('/api/shopping-list/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const db = await getDbConnection();
        
        await db.run(`DELETE FROM shopping_list WHERE id = ?`, [id]);
        res.json({ message: "Item removed from shopping list", id });
    } catch (err) {
        console.error("❌ Error removing shopping list item:", err);
        res.status(500).json({ error: err.message });
    }
});

// 📸 POST: Multi-modal Whole Receipt Scan parsing
app.post('/api/pantry/scan-receipt', async (req, res) => {
    try {
        const { imageBase64 } = req.body; 
        if (!imageBase64) return res.status(400).json({ error: "No receipt image data received." });

        const imagePart = {
            inlineData: {
                data: imageBase64.split(",")[1] || imageBase64,
                mimeType: "image/jpeg"
            }
        };

        const prompt = `You are a high-speed store receipt data extraction engine. 
        Analyze this receipt image and extract all identifiable food items, ingredients, or groceries.
        
        CRITICAL PARSING RULES:
        1. Decode store text abbreviations into clean names (e.g., convert 'ORG BNN' to 'Organic Banana').
        2. Cleanly ignore non-food items entirely (like bags, taxes, structural codes).
        3. Guess a realistic, conservative 'days_until_expiry' integer based on typical ingredient decay cycles.
        
        Return an array under a root 'items' key matching this exact format:
        {
          "items": [
             { "name": "Organic Banana", "quantity": "1 bunch", "days_until_expiry": 5 },
             { "name": "2% Milk", "quantity": "1 carton", "days_until_expiry": 10 }
          ]
        }`;

        const response = await ai.models.generateContent({
            model: "gemini-3.5-flash", 
            contents: [prompt, imagePart],
            config: { responseMimeType: "application/json" }
        });

        const parsedData = JSON.parse(response.text);
        res.json({ items: parsedData.items || [] });

    } catch (error) {
        console.error("❌ Receipt scan breakdown:", error);
        res.status(500).json({ error: "Failed to accurately parse the receipt snapshot." });
    }
});

// Listener Setup
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
