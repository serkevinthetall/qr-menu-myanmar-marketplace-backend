/**
 * @temp-feature app-install-call-list
 * TEMPORARY model — delete with Call List feature.
 *
 * Use default mongoose import: named ESM exports like `models`/`model`
 * break on Vercel’s Node ESM loader (“does not provide an export named 'models'”).
 *
 * Statuses: new | not_installed | waiting | please_come_and_install | installed
 * (legacy `not_called` rows deleted on connect).
 */
import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

export const APP_INSTALL_STATUSES = [
  'new',
  'not_installed',
  'waiting',
  'please_come_and_install',
  'installed',
] as const;

export type AppInstallStatus = (typeof APP_INSTALL_STATUSES)[number];

export const APP_INSTALL_REASONS = [
  'no_smartphone',
  'not_interested',
  'will_install_later',
  'other',
] as const;

export type AppInstallReason = (typeof APP_INSTALL_REASONS)[number];

const AppInstallSchema = new Schema(
  {
    odooPartnerId: {
      type: Number,
      required: true,
      unique: true,
      index: true,
    },
    partnerName: { type: String, default: '' },
    partnerPhone: { type: String, default: '' },
    status: {
      type: String,
      enum: APP_INSTALL_STATUSES,
      default: 'new',
      index: true,
    },
    reason: {
      type: String,
      enum: APP_INSTALL_REASONS,
      default: null,
      required: false,
    },
    requestedAt: { type: Date, default: Date.now },
    updatedByEmail: { type: String, default: '' },
    updatedByName: { type: String, default: '' },
  },
  {
    timestamps: true,
    collection: 'app_installs',
  },
);

export type AppInstallDoc = InferSchemaType<typeof AppInstallSchema> & {
  _id: Schema.Types.ObjectId;
};

export const AppInstallModel: Model<AppInstallDoc> =
  (mongoose.models.AppInstall as Model<AppInstallDoc>) ||
  mongoose.model<AppInstallDoc>('AppInstall', AppInstallSchema);

/** Remove legacy Not called rows from Call List (status retired). */
export async function migrateLegacyNotCalledStatus(): Promise<void> {
  // Use native collection so invalid enum values still match.
  await AppInstallModel.collection.deleteMany({ status: 'not_called' });
}

export function isAppInstallStatus(value: unknown): value is AppInstallStatus {
  return (
    typeof value === 'string' &&
    (APP_INSTALL_STATUSES as readonly string[]).includes(value)
  );
}

export function isAppInstallReason(value: unknown): value is AppInstallReason {
  return (
    typeof value === 'string' &&
    (APP_INSTALL_REASONS as readonly string[]).includes(value)
  );
}

export function normalizeAppInstallStatus(value: unknown): AppInstallStatus {
  if (value === 'installed') return 'installed';
  if (value === 'waiting') return 'waiting';
  if (value === 'please_come_and_install') return 'please_come_and_install';
  if (value === 'new') return 'new';
  // Legacy not_called and unknown values → not_installed
  return 'not_installed';
}

export function appInstallStatusLabel(status: AppInstallStatus): string {
  switch (status) {
    case 'installed':
      return 'Installed';
    case 'waiting':
      return 'Waiting';
    case 'please_come_and_install':
      return 'Please come and install';
    case 'new':
      return 'New';
    default:
      return 'Not installed';
  }
}

export function appInstallReasonLabel(reason: AppInstallReason | null | undefined): string {
  switch (reason) {
    case 'no_smartphone':
      return 'No smartphone';
    case 'not_interested':
      return 'Not interested';
    case 'will_install_later':
      return 'Will install later';
    case 'other':
      return 'Other';
    default:
      return '';
  }
}
