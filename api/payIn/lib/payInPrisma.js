// Relations/columns stripped from the schema. They cannot be included/create/d
// on the real PayIn model; ignoring them keeps the piconeros:0 fee path alive.
const GHOST_KEYS = new Set([
  'payInCustodialTokens',
  'payOutCustodialTokens',
  'pessimisticEnv'
])

export function payInPrismaCreate (payIn) {
  const result = {}

  if (Array.isArray(payIn.beneficiaries)) {
    payIn.beneficiaries = payIn.beneficiaries.map(beneficiary => {
      if (beneficiary.beneficiaries) {
        throw new Error('Beneficiary beneficiaries not supported')
      }
      return {
        ...beneficiary,
        payInState: payIn.payInState
      }
    })
  }

  // for each key in payIn, if the value is an object, recursively call payInPrismaCreate on the value
  // if the value is an array, recursively call payInPrismaCreate on each element of the array
  // if the value is not an object or array, add the key and value to the result
  for (const key in payIn) {
    if (GHOST_KEYS.has(key)) {
      continue
    }
    if (Array.isArray(payIn[key])) {
      result[key] = { create: payIn[key].map(item => payInPrismaCreate(item)) }
    } else if (isPlainObject(payIn[key])) {
      result[key] = { create: payInPrismaCreate(payIn[key]) }
    } else if (payIn[key] !== undefined) {
      result[key] = payIn[key]
    }
  }

  return result
}

// from the top level PayIn and beneficiaries, we just want piconeros, payIntype, userId, genesisId and arrays and objects nested within
// from the nested arrays and objects, we want anything but the payInId
// do all of it recursively

export function payInClone (payIn) {
  const result = {
    piconeros: payIn.piconeros,
    payInType: payIn.payInType,
    userId: payIn.userId,
    genesisId: payIn.genesisId ?? payIn.id
  }
  for (const key in payIn) {
    if (GHOST_KEYS.has(key)) {
      continue
    }
    if (Array.isArray(payIn[key])) {
      if (key === 'beneficiaries') {
        result[key] = payIn[key].map(beneficiary => payInClone(beneficiary))
      } else {
        result[key] = payIn[key].map(item => payInCloneNested(item))
      }
    } else if (isPlainObject(payIn[key])) {
      result[key] = payInCloneNested(payIn[key])
    }
  }
  return result
}

const IGNORE_KEYS = ['payInId', 'id', 'payOutCustodialTokenId', 'createdAt', 'updatedAt']

// this assumes that any other nested object only has a payInId or id that should be ignored
function payInCloneNested (payInNested) {
  const result = {}
  for (const key in payInNested) {
    if (Array.isArray(payInNested[key])) {
      result[key] = payInNested[key].map(item => payInCloneNested(item))
    } else if (isPlainObject(payInNested[key])) {
      result[key] = payInCloneNested(payInNested[key])
    } else if (!IGNORE_KEYS.includes(key) && payInNested[key] !== null) {
      result[key] = payInNested[key]
    }
  }
  return result
}

function isPlainObject (value) {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return (prototype === null || prototype === Object.prototype || Object.getPrototypeOf(prototype) === null) && !(Symbol.toStringTag in value) && !(Symbol.iterator in value)
}
