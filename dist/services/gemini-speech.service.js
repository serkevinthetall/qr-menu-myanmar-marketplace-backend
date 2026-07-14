const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const TRANSCRIBE_PROMPT = 'Transcribe this audio accurately for a delivery note on a sales quotation. ' +
    'The speaker may use Myanmar (Burmese), English, or both in the same sentence. ' +
    'Write Myanmar speech in Myanmar Unicode and keep English words in English. ' +
    'Preserve addresses, landmarks, phone numbers, and shop names exactly. ' +
    'Keep numbers as digits when spoken as numbers. ' +
    'Return only the transcript text, no quotes or explanation.';
export async function transcribeMyanmarAudio(apiKey, audioBase64, mimeType) {
    const response = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [
                {
                    parts: [
                        { text: TRANSCRIBE_PROMPT },
                        {
                            inline_data: {
                                mime_type: mimeType,
                                data: audioBase64,
                            },
                        },
                    ],
                },
            ],
        }),
    });
    const data = (await response.json());
    if (!response.ok) {
        throw new Error(data.error?.message ?? 'Gemini transcription failed.');
    }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
    if (!text) {
        throw new Error('No speech detected in the recording.');
    }
    return text;
}
