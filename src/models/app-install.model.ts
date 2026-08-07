import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

export const APP_INSTALL_STATUSES = [
  'not_called',
  'not_installed',
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
      default: 'not_called',
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
  (models.AppInstall as Model<AppInstallDoc>) ||
  model<AppInstallDoc>('AppInstall', AppInstallSchema);

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

export function appInstallStatusLabel(status: AppInstallStatus): string {
  switch (status) {
    case 'installed':
      return 'Installed';
    case 'not_installed':
      return 'Not installed';
    default:
      return 'Not called';
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
