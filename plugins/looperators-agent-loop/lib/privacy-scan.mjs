const CAPABILITY_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const ACCEPTANCE_PROMPT_FRAGMENTS = Object.freeze([
  "Run the disposable looperators P1-E release-candidate acceptance",
  "P1E_ROOT_STOP_PROBE",
]);

function secretBearingField(name) {
  if (typeof name !== "string") {
    return false;
  }
  const normalized = name.toLowerCase();
  if (
    normalized.includes("digest") ||
    normalized.includes("hash")
  ) {
    return false;
  }
  return (
    normalized === "capability" ||
    normalized === "capabilitytoken" ||
    normalized === "token" ||
    normalized.endsWith("token") ||
    normalized.includes("secret") ||
    normalized.includes("credential")
  );
}

export function createPrivacyScanResult() {
  return {
    jsonFiles: 0,
    plaintextCapabilityFields: 0,
    plaintextCapabilityCandidates: 0,
    rawAcceptancePromptFragments: 0,
  };
}

export function scanPrivacyValue(
  value,
  result,
  fieldName = undefined,
) {
  if (Array.isArray(value)) {
    for (const item of value) {
      scanPrivacyValue(item, result, fieldName);
    }
    return result;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (secretBearingField(key)) {
        result.plaintextCapabilityFields += 1;
      }
      scanPrivacyValue(item, result, key);
    }
    return result;
  }
  if (typeof value !== "string") {
    return result;
  }
  if (
    secretBearingField(fieldName) &&
    CAPABILITY_SHAPE.test(value)
  ) {
    result.plaintextCapabilityCandidates += 1;
  }
  if (
    ACCEPTANCE_PROMPT_FRAGMENTS.some((fragment) =>
      value.includes(fragment),
    )
  ) {
    result.rawAcceptancePromptFragments += 1;
  }
  return result;
}
