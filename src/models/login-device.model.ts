import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

/**
 * Website login devices / active sessions for Settings → Devices.
 * One document per browser/device login (sessionId is also in the JWT `sid`).
 */
const LoginDeviceSchema = new Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    userEmail: { type: String, default: '' },
    userName: { type: String, default: '' },
    label: { type: String, default: 'Unknown device' },
    platform: { type: String, default: 'Unknown' },
    browser: { type: String, default: 'Browser' },
    userAgent: { type: String, default: '' },
    ip: { type: String, default: '' },
    lastSeenAt: { type: Date, default: Date.now },
    revokedAt: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
    collection: 'login_devices',
  },
);

LoginDeviceSchema.index({ userId: 1, revokedAt: 1, lastSeenAt: -1 });

export type LoginDeviceDoc = InferSchemaType<typeof LoginDeviceSchema> & {
  _id: Schema.Types.ObjectId;
};

export const LoginDeviceModel: Model<LoginDeviceDoc> =
  (mongoose.models.LoginDevice as Model<LoginDeviceDoc>) ||
  mongoose.model<LoginDeviceDoc>('LoginDevice', LoginDeviceSchema);
