export interface VroidLicenseRow {
  label: string;
  value: string;
}

interface VroidLicenseField<Key extends string = string> {
  key: Key;
  label: string;
  values: Record<string, string>;
}

const ALLOW_VALUES = {
  default: 'Not set',
  allow: 'Allow',
  disallow: 'Do not allow',
};

// Keep the labels, ordering, and value wording aligned with VRoid Hub's
// conditions-of-use display guidelines. VRM 0.0 and VRM 1.0 expose different
// source shapes, so each version has its own display table.
const VROID_LICENSE_FIELDS_V0: VroidLicenseField<
  keyof PersonaVroidHubCharacterLicenseV0
>[] = [
  {
    key: 'characterization_allowed_user',
    label: 'Avatar use',
    values: { default: 'Not set', author: 'Do not allow', everyone: 'Allow' },
  },
  {
    key: 'violent_expression',
    label: 'Violent acts',
    values: ALLOW_VALUES,
  },
  {
    key: 'sexual_expression',
    label: 'Sexual acts',
    values: ALLOW_VALUES,
  },
  {
    key: 'corporate_commercial_use',
    label: 'Corporate use',
    values: ALLOW_VALUES,
  },
  {
    key: 'personal_commercial_use',
    label: 'Individual commercial use',
    values: {
      default: 'Not set',
      disallow: 'Do not allow',
      profit: 'Allow',
      nonprofit: 'Non-profit activities only',
    },
  },
  {
    key: 'redistribution',
    label: 'Redistribution',
    values: ALLOW_VALUES,
  },
  {
    key: 'modification',
    label: 'Alterations',
    values: ALLOW_VALUES,
  },
  {
    key: 'credit',
    label: 'Attribution',
    values: {
      default: 'Not set',
      necessary: 'Required',
      unnecessary: 'Not required',
    },
  },
];

const BOOLEAN_PERMISSION_VALUES = {
  true: 'Allow',
  false: 'Do not allow',
};

const VROID_LICENSE_FIELDS_V1: VroidLicenseField<
  keyof PersonaVroidHubCharacterLicenseV1
>[] = [
  {
    key: 'avatarPermission',
    label: 'Avatar use',
    values: {
      onlyAuthor: 'Do not allow',
      onlySeparatelyLicensedPerson: 'Do not allow',
      everyone: 'Allow',
    },
  },
  {
    key: 'allowExcessivelyViolentUsage',
    label: 'Violent acts',
    values: BOOLEAN_PERMISSION_VALUES,
  },
  {
    key: 'allowExcessivelySexualUsage',
    label: 'Sexual acts',
    values: BOOLEAN_PERMISSION_VALUES,
  },
  {
    key: 'allowPoliticalOrReligiousUsage',
    label: 'Political/religious acts',
    values: BOOLEAN_PERMISSION_VALUES,
  },
  {
    key: 'allowAntisocialOrHateUsage',
    label: 'Antisocial/hateful acts',
    values: BOOLEAN_PERMISSION_VALUES,
  },
  {
    key: 'commercialUsage',
    label: 'Corporate use',
    values: {
      personalNonProfit: 'Do not allow',
      personalProfit: 'Do not allow',
      corporation: 'Allow',
    },
  },
  {
    key: 'commercialUsage',
    label: 'Individual commercial use',
    values: {
      personalNonProfit: 'Do not allow',
      personalProfit: 'Allow',
      corporation: 'Allow',
    },
  },
  {
    key: 'allowRedistribution',
    label: 'Redistribution',
    values: BOOLEAN_PERMISSION_VALUES,
  },
  {
    key: 'modification',
    label: 'Alterations',
    values: {
      prohibited: 'Do not allow',
      allowModification: 'Allow',
      allowModificationRedistribution: 'Allow',
    },
  },
  {
    key: 'modification',
    label: 'Redistribution of altered model',
    values: {
      prohibited: 'Do not allow',
      allowModification: 'Do not allow',
      allowModificationRedistribution: 'Allow',
    },
  },
  {
    key: 'creditNotation',
    label: 'Attribution',
    values: { required: 'Required', unnecessary: 'Not required' },
  },
];

export function vroidLicenseRows(
  license: PersonaVroidHubCharacterLicense | null | undefined,
): VroidLicenseRow[] {
  if (!license) return [];

  function rowsFor<TLicense extends object>(
    value: TLicense,
    fields: readonly VroidLicenseField<Extract<keyof TLicense, string>>[],
  ): VroidLicenseRow[] {
    return fields.map(({ key, label, values: displayValues }) => {
      const raw = value[key];
      if (raw == null) return { label, value: 'Not set' };
      return { label, value: displayValues[String(raw)] ?? String(raw) };
    });
  }

  return license.spec_version === '1.0'
    ? rowsFor(license, VROID_LICENSE_FIELDS_V1)
    : rowsFor(license, VROID_LICENSE_FIELDS_V0);
}
