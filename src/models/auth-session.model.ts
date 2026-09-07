import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

/**
 * Server-side auth session: Odoo cookie lives here, never in the JWT.
 * Prefer Redis when available; Mongo is the durable fallback.
 */
const AuthSessionSchema = new Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    email: { type: String, required: true },
    name: { type: String, required: true },
    odooCookie: { type: String, required: true },
    odooUid: { type: Number, required: true },
    surface: { type: String, enum: ['web', 'app'], default: 'web' },
    expiresAt: { type: Date, required: true, index: true },
    createdAt: { type: Date, required: true, default: Date.now },
  },
  { collection: 'auth_sessions' },
);

AuthSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type AuthSessionDoc = InferSchemaType<typeof AuthSessionSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const AuthSessionModel =
  (mongoose.models.AuthSession as Model<AuthSessionDoc>) ||
  mongoose.model<AuthSessionDoc>('AuthSession', AuthSessionSchema);
