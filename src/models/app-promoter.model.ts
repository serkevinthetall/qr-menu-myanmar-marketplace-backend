/**
 * App Promoter names for the install Request dropdown (MongoDB master list).
 */
import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

export const DEFAULT_APP_PROMOTER_NAMES = ['Kyaw Kyaw', 'Thi Ha'] as const;

const AppPromoterSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
    },
    active: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
    collection: 'app_promoters',
  },
);

export type AppPromoterDoc = InferSchemaType<typeof AppPromoterSchema> & {
  _id: Schema.Types.ObjectId;
};

export const AppPromoterModel: Model<AppPromoterDoc> =
  (mongoose.models.AppPromoter as Model<AppPromoterDoc>) ||
  mongoose.model<AppPromoterDoc>('AppPromoter', AppPromoterSchema);

function normalizePromoterName(value: unknown): string {
  if (value === false || value === null || value === undefined) {
    return '';
  }
  return String(value).trim().replace(/\s+/g, ' ');
}

/** Seed Kyaw Kyaw / Thi Ha when the collection is empty. */
export async function seedDefaultAppPromotersIfEmpty(): Promise<void> {
  const count = await AppPromoterModel.estimatedDocumentCount();
  if (count > 0) {
    return;
  }
  await AppPromoterModel.insertMany(
    DEFAULT_APP_PROMOTER_NAMES.map(name => ({ name, active: true })),
    { ordered: true },
  );
}

export async function findActiveAppPromoterByName(
  name: unknown,
): Promise<AppPromoterDoc | null> {
  const normalized = normalizePromoterName(name);
  if (!normalized) {
    return null;
  }
  return AppPromoterModel.findOne({
    name: normalized,
    active: true,
  }).lean() as Promise<AppPromoterDoc | null>;
}

export { normalizePromoterName };
