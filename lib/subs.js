/**
 * Utilities for working with sub/territory arrays
 */

/**
 * Extract sub names from an array of sub objects or strings
 * @param {Array} subs - Array of sub objects or strings
 * @returns {string[]} Array of sub name strings
 */
export function subNames (subs) {
  if (!subs?.length) return []
  return subs.map(s => typeof s === 'string' ? s : s.name)
}

/**
 * Parse sub names from URL format (e.g., 'bitcoin~nostr' -> ['bitcoin', 'nostr'])
 * @param {string} slugSub - URL sub parameter
 * @returns {string[]} Array of sub name strings
 */
export function subNamesFromSlug (slugSub) {
  if (!slugSub) return []
  return slugSub.split('~').filter(Boolean)
}

/**
 * Generate URL prefix from subs (e.g., '/~bitcoin~nostr')
 * @param {Array} subs - Array of sub objects or strings
 * @returns {string} URL prefix or empty string
 */
export function subsPostPrefix (subs) {
  const names = subNames(subs)
  return names.length ? `/~${names.join('~')}` : ''
}

/**
 * Check if all subs support a given post type
 * @param {Array} subs - Array of sub objects
 * @param {string} postType - Post type to check (e.g., 'LINK', 'DISCUSSION')
 * @returns {boolean}
 */
export function subsAllSupport (subs, postType) {
  if (!subs?.length) return false
  return subs.every(s => s.postTypes?.includes(postType))
}

/**
 * Get post types supported by all subs
 * @param {Array} subs - Array of sub objects
 * @returns {string[]} Array of post types supported by all subs
 */
export function subsCommonPostTypes (subs) {
  if (!subs?.length) return []
  const allTypes = ['LINK', 'DISCUSSION', 'POLL', 'BOUNTY']
  return allTypes.filter(type => subsAllSupport(subs, type))
}

/**
 * Find elements in array a that are not in array b
 * Works with both strings and objects (compares by name property)
 * @param {Array} a - Source array
 * @param {Array} b - Array to subtract
 * @returns {Array} Elements in a but not in b
 */
export function subsDiff (a = [], b = []) {
  const bNames = subNames(b)
  const aNames = subNames(a)
  return aNames.filter(name => !bNames.includes(name))
}

const POST_FORM_TYPES = ['link', 'discussion', 'poll', 'bounty']

/**
 * Resolve the post form for a post page. Jobs exist only in the `jobs` turf,
 * so job types resolve only there, and unknown types resolve to nothing
 * instead of silently becoming a job post.
 * @param {string} type - requested post type
 * @param {Array} subs - target sub objects
 * @returns {string|undefined} form type or undefined (render the picker)
 */
export function postFormType (type, subs) {
  if (POST_FORM_TYPES.includes(type)) return type
  if ((type === 'job' || type === 'jobs') && subNames(subs).includes('jobs')) return 'job'
  return undefined
}

/**
 * The form preselected by a single-postType turf. JOB alone is legacy and
 * does not select the job form.
 * @param {Array} subs - target sub objects
 * @returns {string|undefined} lowercase post type or undefined
 */
export function defaultPostType (subs) {
  if (subs?.length === 1 && subs[0].postTypes?.length === 1 && subs[0].postTypes[0] !== 'JOB') {
    return subs[0].postTypes[0].toLowerCase()
  }
  return undefined
}

/**
 * The post type of an existing item, for the repost target check. Mirrors the
 * server's field precedence (bounty, poll, link, else discussion); jobs are
 * excluded because job identity is the literal `jobs` sub.
 * @param {Object} item - item with bountyPiconeros/pollCost/url/subNames/parentId/bio
 * @returns {string|undefined} uppercase post type, or undefined when the item
 *   cannot be reposted (comment, bio, missing)
 */
export function itemPostType (item) {
  if (!item || item.parentId || item.bio) return undefined
  if (subNames(item.subNames).includes('jobs')) return 'JOB'
  if (item.bountyPiconeros != null || item.bounty != null) return 'BOUNTY'
  if (item.pollCost != null) return 'POLL'
  if (item.url) return 'LINK'
  return 'DISCUSSION'
}
