import express from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';
import JSZip from 'jszip';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // JSON payload parser with 25MB limit for high-res mobile camera photos
  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: true, limit: '25mb' }));

  // Status and configuration check
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0),
      timestamp: new Date().toISOString()
    });
  });

  // Secure Server-Side Food Photo Nutrition Analysis
  app.post('/api/scan-food', async (req, res) => {
    try {
      const apiKey = process.env.GEMINI_API_KEY;

      // Strict enforcement: Never invent fake AI results if no key is configured
      if (!apiKey || apiKey.trim().length === 0 || apiKey === 'MY_GEMINI_API_KEY') {
        return res.status(503).json({
          error: 'AI_KEY_NOT_CONFIGURED',
          message: 'GEMINI_API_KEY is not configured on the server. Please configure your key in Google AI Studio (Settings > Secrets) or in your .env file to enable live AI vision scanning.'
        });
      }

      const { imageBase64, mimeType = 'image/jpeg', userPrompt } = req.body;

      if (!imageBase64 || typeof imageBase64 !== 'string') {
        return res.status(400).json({
          error: 'INVALID_IMAGE',
          message: 'No image data was provided or format is invalid.'
        });
      }

      // Clean base64 string if it contains data URI header
      const cleanedBase64 = imageBase64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');

      const ai = new GoogleGenAI({
        apiKey: apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });

      const analysisPrompt = `You are a certified sports nutritionist and dietary analyst specializing in protein-focused macronutrient breakdown.
Analyze this meal photo meticulously:
1. Identify each distinct food ingredient and item on the plate, bowl, or container.
2. Estimate the portion size (e.g. "180g / 6.3 oz", "1.5 cups cooked", "2 large whole eggs").
3. For each item, estimate macronutrients based on USDA/standard food composition databases:
   - Protein (grams)
   - Calories (kcal)
   - Carbohydrates (grams)
   - Fat (grams)
4. Calculate accurate meal totals.
5. Provide a realistic confidence level ('high', 'medium', or 'low') based on visual clarity and invisible ingredients (e.g., cooking oils, dressings, hidden sugars).
6. Note high-protein attributes or dietary insights (e.g. "Complete protein source", "Rich in Leucine", "Low carb high protein").
${userPrompt ? `User notes about this meal: "${userPrompt}"` : ''}

Be realistic and objective. All estimations must be marked clearly as dietary approximations.`;

      const response = await ai.models.generateContent({
       model: 'gemini-1.5-flash-latest',
        
       
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: mimeType,
                data: cleanedBase64,
              },
            },
            {
              text: analysisPrompt,
            },
          ],
        },
        config: {
          temperature: 0.2, // Low temperature for consistent nutritional estimation
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              dishTitle: {
                type: Type.STRING,
                description: 'Descriptive title of the meal (e.g., "Grilled Herb Chicken Breast with Steamed Jasmine Rice and Broccoli")'
              },
              confidence: {
                type: Type.STRING,
                description: 'high, medium, or low confidence in portion and macro estimations'
              },
              summary: {
                type: Type.STRING,
                description: 'Concise 1-2 sentence nutritional evaluation of the meal'
              },
              items: {
                type: Type.ARRAY,
                description: 'Individual items detected on the plate',
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: {
                      type: Type.STRING,
                      description: 'Name of the ingredient or item'
                    },
                    estimatedPortion: {
                      type: Type.STRING,
                      description: 'Portion weight or volume estimate, e.g. 200g (7 oz)'
                    },
                    protein: {
                      type: Type.NUMBER,
                      description: 'Estimated protein in grams'
                    },
                    calories: {
                      type: Type.NUMBER,
                      description: 'Estimated calories in kcal'
                    },
                    carbs: {
                      type: Type.NUMBER,
                      description: 'Estimated carbohydrates in grams'
                    },
                    fat: {
                      type: Type.NUMBER,
                      description: 'Estimated fat in grams'
                    },
                    confidence: {
                      type: Type.STRING,
                      description: 'high, medium, or low'
                    },
                    notes: {
                      type: Type.STRING,
                      description: 'Portion or cooking method rationale'
                    }
                  },
                  required: ['name', 'estimatedPortion', 'protein', 'calories', 'carbs', 'fat']
                }
              },
              totalProtein: {
                type: Type.NUMBER,
                description: 'Sum of protein in grams'
              },
              totalCalories: {
                type: Type.NUMBER,
                description: 'Sum of calories in kcal'
              },
              totalCarbs: {
                type: Type.NUMBER,
                description: 'Sum of carbohydrates in grams'
              },
              totalFat: {
                type: Type.NUMBER,
                description: 'Sum of fat in grams'
              },
              dietaryTags: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Tags such as High Protein, Lean, Balanced, Whole Foods, etc.'
              },
              estimationDisclaimer: {
                type: Type.STRING,
                description: 'Standard disclaimer that this is an AI visual estimate'
              }
            },
            required: ['dishTitle', 'items', 'totalProtein', 'totalCalories', 'totalCarbs', 'totalFat', 'confidence']
          }
        }
      });

      const rawJson = response.text;
      if (!rawJson) {
        throw new Error('Model did not return a response.');
      }

      const parsedData = JSON.parse(rawJson);

      // Ensure rounded whole numbers or 1 decimal place for neat display
      parsedData.totalProtein = Math.round(Number(parsedData.totalProtein) || 0);
      parsedData.totalCalories = Math.round(Number(parsedData.totalCalories) || 0);
      parsedData.totalCarbs = Math.round(Number(parsedData.totalCarbs) || 0);
      parsedData.totalFat = Math.round(Number(parsedData.totalFat) || 0);

      if (Array.isArray(parsedData.items)) {
        parsedData.items = parsedData.items.map((item: any) => ({
          ...item,
          protein: Math.round(Number(item.protein) || 0),
          calories: Math.round(Number(item.calories) || 0),
          carbs: Math.round(Number(item.carbs) || 0),
          fat: Math.round(Number(item.fat) || 0),
        }));
      }

      parsedData.estimationDisclaimer = parsedData.estimationDisclaimer || 
        'AI Nutrition Estimate: Visual approximation only. Actual nutritional values vary by cooking oils, ingredients, and seasoning.';

      return res.json({
        success: true,
        data: parsedData
      });

    } catch (error: any) {
      console.error('Error in /api/scan-food:', error);
      return res.status(500).json({
        error: 'SCAN_FAILED',
        message: error?.message || 'Failed to analyze food photo. Please try again with clear lighting.',
        details: process.env.NODE_ENV === 'development' ? String(error) : undefined
      });
    }
  });

  // Endpoint to download the entire source code as a ZIP file on any device / phone
  app.get('/api/export-project-zip', async (_req, res) => {
    try {
      const zip = new JSZip();
      const rootDir = process.cwd();

      async function addFolderToZip(dirPath: string, zipFolder: JSZip) {
        const items = await fs.readdir(dirPath, { withFileTypes: true });
        for (const item of items) {
          // Exclude large binaries or build directories
          if (
            item.name === 'node_modules' ||
            item.name === '.git' ||
            item.name === 'dist' ||
            item.name === '.aistudio' ||
            item.name === 'bun.lock' ||
            item.name === 'package-lock.json'
          ) {
            continue;
          }

          const fullPath = path.join(dirPath, item.name);
          if (item.isDirectory()) {
            const subFolder = zipFolder.folder(item.name);
            if (subFolder) {
              await addFolderToZip(fullPath, subFolder);
            }
          } else if (item.isFile()) {
            const content = await fs.readFile(fullPath);
            zipFolder.file(item.name, content);
          }
        }
      }

      await addFolderToZip(rootDir, zip);

      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="forge-protein-tracker-source.zip"');
      res.setHeader('Content-Length', zipBuffer.length);
      res.end(zipBuffer);
    } catch (error: any) {
      console.error('Error generating project ZIP:', error);
      res.status(500).json({ error: 'EXPORT_FAILED', message: error?.message || 'Failed to generate project ZIP' });
    }
  });

  // Vite middleware for dev or static serving for production
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }
app.post('/api/food-chat', async (req, res) => {
  try {
    const { foodQuery } = req.body;
    if (!foodQuery) {
      return res.status(400).json({ error: 'Food item is required' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on server' });
    }

    const systemPrompt = `You are Forge Protein Assistant. Calculate accurate macros for the given food items.
Always respond in simple Hinglish in this exact clean structure:
🍽️ Khana: [Food item with estimated quantity]
💪 Protein: [X]g
🔥 Calories: [X] kcal
🌾 Carbs: [X]g
🥑 Fats: [X]g
💡 Quick Tip: [1 short line tip for muscle/fat loss]`;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`, {
      
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: `${systemPrompt}\n\nUser asked: ${foodQuery}` }]
          }
        ]
      })
    });

    const data = await response.json();
    if (data.error) {
      return res.status(response.status).json(data);
    }

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "Maaf kijiye, details calculate nahi ho payi.";
    res.json({ reply });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Forge Protein Tracker backend running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
