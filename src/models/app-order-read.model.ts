import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

/**
 * Team-wide App Order read markers.
 * Redis is preferred; Mongo is the durable Vercel fallback when REDIS_URL fails.
 */
const AppOrderReadSchema = new Schema(
  {
    orderId: { type: Number, required: true, unique: true, index: true },
    readAt: { type: Date, required: true, default: Date.now },
  },
  { collection: 'app_order_reads' },
);

export type AppOrderReadDoc = InferSchemaType<typeof AppOrderReadSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const AppOrderReadModel =
  (mongoose.models.AppOrderRead as Model<AppOrderReadDoc>) ||
  mongoose.model<AppOrderReadDoc>('AppOrderRead', AppOrderReadSchema);
