export function getBeneficiariesPiconeros (beneficiaries) {
  return beneficiaries?.reduce((acc, beneficiary) => acc + beneficiary.piconeros, 0n) ?? 0n
}
