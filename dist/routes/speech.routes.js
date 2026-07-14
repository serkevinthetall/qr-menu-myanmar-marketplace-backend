import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { authMiddleware } from '../middleware/auth.js';
import { transcribeMyanmarAudio } from '../services/gemini-speech.service.js';
const router = Router();
const transcribeSchema = z.object({
    audio: z.string().min(1),
    mimeType: z.string().min(1).default('audio/webm'),
});
router.post('/transcribe', authMiddleware, async (req, res) => {
    if (!env.geminiApiKey) {
        return res.status(503).json({ message: 'Speech service is not configured.' });
    }
    const parsed = transcribeSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ message: 'Invalid audio payload.' });
    }
    try {
        const text = await transcribeMyanmarAudio(env.geminiApiKey, parsed.data.audio, parsed.data.mimeType);
        return res.json({ text });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Transcription failed.';
        return res.status(502).json({ message });
    }
});
export default router;
