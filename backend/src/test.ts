import { GoogleGenAI } from '@google/genai';
import 'dotenv/config';

if (!process.env.GEMINI_API_KEY) {
    console.error("❌ Error: GEMINI_API_KEY is missing from the .env file.");
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function runDiagnostics() {
    console.log("Booting ShadowMesh Brain...");
    
    try {
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