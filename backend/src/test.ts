import { GoogleGenAI } from '@google/genai';
import 'dotenv/config';

// 1. Safety check for the environment variable
if (!process.env.GEMINI_API_KEY) {
    console.error("❌ Error: GEMINI_API_KEY is missing from the .env file.");
    process.exit(1);
}

// 2. Initialize the AI Client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function runDiagnostics() {
    console.log("Booting ShadowMesh Brain...");
    
    try {
        // 3. Ping the Gemini 3 Flash model
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: 'Acknowledge system boot. Respond strictly with: "ShadowMesh Node Online. Ready for dark pool negotiation."',
        });

        console.log("\n✅ AI Response:", response.text);
    } catch (error) {
        console.error("\n❌ Connection Failed:", error);
    }
}

runDiagnostics();