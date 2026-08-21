import * as math from 'mathjs'
import { USER_ID } from '@/lib/constants'
import { Prisma } from '@prisma/client'
import { initialTrust, GLOBAL_SEEDS } from '@/api/payIn/lib/territory'

const MAX_DEPTH = 40
const MAX_TRUST = 1
const MIN_SUCCESS = 0
// https://en.wikipedia.org/wiki/Normal_distribution#Quantile_function
const Z_CONFIDENCE = 1.959963984540 // 95% confidence
const SEED_WEIGHT = 0.83
const AGAINST_PICO_MIN = 1000
const PICO_MIN = 1001 // 20001 is the minimum for a tip to be counted in trust
const IRRELEVANT_CUMULATIVE_TRUST = 0.001 // if a user has less than this amount of cumulative trust, they are irrelevant

// for each subName, we'll need to get two graphs
// one for comments and one for posts
// then we'll need to do two trust calculations on each graph
// one with global seeds and one with subName seeds
export async function trust ({ boss, models }) {
  console.time('trust')
  const territories = await models.sub.findMany({
    where: {
      status: 'ACTIVE'
    }
  })
  for (const territory of territories) {
    const seeds = GLOBAL_SEEDS.includes(territory.userId) ? GLOBAL_SEEDS : GLOBAL_SEEDS.concat(territory.userId)
    try {
      console.timeLog('trust', `getting post graph for ${territory.name}`)
      const postGraph = await getGraph(models, territory.name, true, seeds)
      console.timeLog('trust', `getting comment graph for ${territory.name}`)
      const commentGraph = await getGraph(models, territory.name, false, seeds)
      console.timeLog('trust', `computing global post trust for ${territory.name}`)
      const vGlobalPost = await trustGivenGraph(postGraph)
      console.timeLog('trust', `computing global comment trust for ${territory.name}`)
      const vGlobalComment = await trustGivenGraph(commentGraph)
      console.timeLog('trust', `computing sub post trust for ${territory.name}`)
      const vSubPost = await trustGivenGraph(postGraph, [territory.userId])
      console.timeLog('trust', `computing sub comment trust for ${territory.name}`)
      const vSubComment = await trustGivenGraph(commentGraph, [territory.userId])
      console.timeLog('trust', `storing trust for ${territory.name}`)
      let results = reduceVectors(territory.name, {
        zapPostTrust: {
          graph: postGraph,
          vector: vGlobalPost
        },
        subZapPostTrust: {
          graph: postGraph,
          vector: vSubPost
        },
        zapCommentTrust: {
          graph: commentGraph,
          vector: vGlobalComment
        },
        subZapCommentTrust: {
          graph: commentGraph,
          vector: vSubComment
        }
      })

      if (results.length === 0) {
        console.timeLog('trust', `no results for ${territory.name} - adding seeds`)
        results = initialTrust({ name: territory.name, userId: territory.userId })
      }

      await storeTrust(models, territory.name, results)
    } catch (e) {
      console.error(`error computing trust for ${territory.name}:`, e)
    } finally {
      console.timeLog('trust', `finished computing trust for ${territory.name}`)
    }
  }
  console.timeEnd('trust')
}

/*
 Given a graph and start this function returns an object where
 the keys are the node id and their value is the trust of that node
*/
// I'm going to need to send subName, and multiply by a vector instead of a matrix
function trustGivenGraph (graph, seeds = GLOBAL_SEEDS) {
  console.timeLog('trust', `creating matrix of size ${graph.length} x ${graph.length}`)
  // empty matrix of proper size nstackers x nstackers
  const mat = math.zeros(graph.length, graph.length, 'sparse')

  // create a map of user id to position in matrix
  const posByUserId = {}
  for (const [idx, val] of graph.entries()) {
    posByUserId[val.id] = idx
  }

  // iterate over graph, inserting edges into matrix
  for (const [idx, val] of graph.entries()) {
    for (const { node, trust } of val.hops) {
      try {
        mat.set([idx, posByUserId[node]], Number(trust))
      } catch (e) {
        console.log('error:', idx, node, posByUserId[node], trust)
        throw e
      }
    }
  }

  // perform random walk over trust matrix
  // the resulting matrix columns represent the trust a user (col) has for each other user (rows)
  const matT = math.transpose(mat)
  const vTrust = math.zeros(graph.length)
  for (const seed of seeds) {
    vTrust.set([posByUserId[seed], 0], 1.0 / seeds.length)
  }
  let result = vTrust.clone()
  console.timeLog('trust', 'matrix multiply')
  for (let i = 0; i < MAX_DEPTH; i++) {
    result = math.multiply(matT, result)
    result = math.add(math.multiply(1 - SEED_WEIGHT, result), math.multiply(SEED_WEIGHT, vTrust))
  }
  result = math.squeeze(result)
  // squeeze collapses a 1x1 matrix to a bare number (no .size()/forEach);
  // wrap it back so single-node graphs (GLOBAL_SEEDS-only territories with no
  // tip edges) keep flowing through sqapply/reduceVectors instead of crashing
  if (typeof result === 'number') result = math.matrix([result])

  console.timeLog('trust', 'transforming result')

  const seedIdxs = seeds.map(id => posByUserId[id])
  const filterZeroAndSeed = (val, idx) => {
    return val !== 0 && !seedIdxs.includes(idx[0])
  }
  const filterSeed = (val, idx) => {
    return !seedIdxs.includes(idx[0])
  }
  const sqapply = (vec, filterFn, fn) => {
    // if the vector is smaller than the seeds, don't filter
    const filtered = vec.size()[0] > seeds.length ? math.filter(vec, filterFn) : vec
    if (filtered.size()[0] === 0) return 0
    return fn(filtered)
  }

  console.timeLog('trust', 'normalizing')
  console.timeLog('trust', 'stats')
  const std = sqapply(result, filterZeroAndSeed, math.std) // math.squeeze(math.std(mat, 1))
  const mean = sqapply(result, filterZeroAndSeed, math.mean) // math.squeeze(math.mean(mat, 1))
  console.timeLog('trust', 'std', std)
  console.timeLog('trust', 'mean', mean)
  const zscore = math.map(result, (val) => {
    if (std === 0) return 0
    return (val - mean) / std
  })
  console.timeLog('trust', 'minmax')
  const min = sqapply(zscore, filterSeed, math.min) // math.squeeze(math.min(zscore, 1))
  const max = sqapply(zscore, filterSeed, math.max) // math.squeeze(math.max(zscore, 1))
  console.timeLog('trust', 'min', min)
  console.timeLog('trust', 'max', max)
  const normalized = math.map(zscore, (val) => {
    const zrange = max - min
    if (val > max) return MAX_TRUST
    return zrange ? (val - min) / zrange : 0
  })

  return normalized
}

/*
  graph is returned as json in adjacency list where edges are the trust value 0-1
  graph = [
    { id: node1, hops: [{node : node2, trust: trust12}, {node: node3, trust: trust13}] },
    ...
  ]
*/
// I'm going to want to send subName to this function
// and whether it's for comments or posts
// Territory match for the graph queries: an item belongs to a turf when the
// turf is ANY member of its subNames array (membership, mirroring the feeds'
// "subNames" @> ARRAY[...] filters and api/payIn/lib/item.js's ANY() join) —
// cross-posted items contribute their tip/burn edges to EVERY turf they live
// in. Legacy turf-less items (NULL/empty subNames — the posting path requires
// >= 1 turf) attribute to ~meta, a real seeded ACTIVE territory, preserving
// the old COALESCE(subNames[1], 'meta') fallback. cardinality(NULL) is NULL,
// hence the COALESCE(..., 0). GIN-indexable via Item_subNames_idx.
// The comment branch MUST emit its JOIN "Item" root BEFORE the predicate —
// the predicate reads root."subNames", so the alias is only in scope after
// the join appears (mirrors the original inline structure).
function subMatchClause (subName, postTrust) {
  return postTrust
    ? Prisma.sql`(
        "Item"."subNames" @> ARRAY[${subName}]::CITEXT[]
        OR (COALESCE(cardinality("Item"."subNames"), 0) = 0 AND ${subName}::CITEXT = 'meta')
      )`
    : Prisma.sql`JOIN "Item" root ON "Item"."rootId" = root.id AND (
        COALESCE(root."subNames", "Item"."subNames") @> ARRAY[${subName}]::CITEXT[]
        OR (COALESCE(cardinality(root."subNames"), cardinality("Item"."subNames"), 0) = 0 AND ${subName}::CITEXT = 'meta')
      )`
}
async function getGraph (models, subName, postTrust = true, seeds = GLOBAL_SEEDS) {
  return await models.$queryRaw`
    SELECT id, json_agg(json_build_object(
      'node', oid,
      'trust', CASE WHEN total_trust > 0 THEN trust / total_trust::float ELSE 0 END)) AS hops
    FROM (
      WITH user_votes AS (
        SELECT tips."tipperId" AS user_id, users.name AS name, tips."postId" AS item_id,
            max(tips."confirmedAt") AS act_at,
            users.created_at AS user_at, false AS against,
            count(*) OVER (partition by tips."tipperId") AS user_vote_count,
            sum(tips."piconeros") AS user_piconeros
        FROM "ObservedTip" tips
        JOIN "Item" ON "Item".id = tips."postId" AND NOT "Item".bio AND "Item"."userId" <> tips."tipperId"
          AND ${postTrust
            ? Prisma.sql`"Item"."parentId" IS NULL AND ${subMatchClause(subName, true)}`
            : Prisma.sql`
              "Item"."parentId" IS NOT NULL
              ${subMatchClause(subName, false)}`
          }
          AND "Item".created_at > NOW() - INTERVAL '1 year'
        JOIN users ON tips."tipperId" = users.id AND users.id <> ${USER_ID.anon}
        WHERE tips.state = 'CONFIRMED'
        GROUP BY user_id, users.name, item_id, user_at, against
        HAVING sum(tips."piconeros") > ${PICO_MIN}
        UNION ALL
        SELECT burns."downvoterId" AS user_id, users.name AS name, burns."postId" AS item_id,
            max(COALESCE(burns."confirmedAt", burns."detectedAt")) AS act_at,
            users.created_at AS user_at, true AS against,
            count(*) OVER (partition by burns."downvoterId") AS user_vote_count,
            sum(burns."piconeros") AS user_piconeros
        FROM "ObservedDownvote" burns
        JOIN "Item" ON "Item".id = burns."postId" AND NOT "Item".bio AND "Item"."userId" <> burns."downvoterId"
          AND ${postTrust
            ? Prisma.sql`"Item"."parentId" IS NULL AND ${subMatchClause(subName, true)}`
            : Prisma.sql`
              "Item"."parentId" IS NOT NULL
              ${subMatchClause(subName, false)}`
          }
          AND "Item".created_at > NOW() - INTERVAL '1 year'
        JOIN users ON burns."downvoterId" = users.id AND users.id <> ${USER_ID.anon}
        WHERE burns.state IN ('DETECTED', 'CONFIRMED')
        GROUP BY user_id, users.name, item_id, user_at, against
        HAVING sum(burns."piconeros") > ${AGAINST_PICO_MIN}
      ),
      user_pair AS (
        SELECT a.user_id AS a_id, b.user_id AS b_id,
            sum(CASE WHEN b.user_piconeros > a.user_piconeros THEN a.user_piconeros / b.user_piconeros::FLOAT ELSE b.user_piconeros / a.user_piconeros::FLOAT END) FILTER(WHERE a.act_at > b.act_at AND a.against = b.against) AS before,
            sum(CASE WHEN b.user_piconeros > a.user_piconeros THEN a.user_piconeros / b.user_piconeros::FLOAT ELSE b.user_piconeros / a.user_piconeros::FLOAT END) FILTER(WHERE b.act_at > a.act_at AND a.against = b.against) AS after,
            count(*) FILTER(WHERE a.against <> b.against) AS disagree,
            b.user_vote_count AS b_total, a.user_vote_count AS a_total
        FROM user_votes a
        JOIN user_votes b ON a.item_id = b.item_id
        WHERE a.user_id <> b.user_id
        GROUP BY a.user_id, a.user_vote_count, b.user_id, b.user_vote_count
      ),
      trust_pairs AS (
        SELECT a_id AS id, b_id AS oid,
          CASE WHEN COALESCE(before, 0) - COALESCE(disagree, 0) >= ${MIN_SUCCESS}
            AND COALESCE(b_total, 0) - COALESCE(after, 0) > 0 THEN
            confidence(COALESCE(before, 0) - COALESCE(disagree, 0),
              COALESCE(b_total, 0) - COALESCE(after, 0), ${Z_CONFIDENCE})
          ELSE 0 END AS trust
        FROM user_pair
        UNION ALL
        SELECT seed_id AS id, seed_id AS oid, 0 AS trust
        FROM unnest(${seeds}::int[]) seed_id
      )
      SELECT id, oid, trust, sum(trust) OVER (PARTITION BY id) AS total_trust
      FROM trust_pairs
    ) a
    GROUP BY a.id
    ORDER BY id ASC`
}

function reduceVectors (subName, fieldGraphVectors) {
  function reduceVector (field, graph, vector, result = {}) {
    vector.forEach((val, [idx]) => {
      if (isNaN(val) || val <= 0) return
      result[graph[idx].id] = {
        ...result[graph[idx].id],
        subName,
        userId: graph[idx].id,
        [field]: val
      }
    })
    return result
  }

  let result = {}
  for (const field in fieldGraphVectors) {
    result = reduceVector(field, fieldGraphVectors[field].graph, fieldGraphVectors[field].vector, result)
  }

  // return only the users with trust > 0
  return Object.values(result).filter(s =>
    Object.keys(fieldGraphVectors).reduce(
      (acc, key) => acc + (s[key] ?? 0),
      0
    ) > IRRELEVANT_CUMULATIVE_TRUST
  )
}

async function storeTrust (models, subName, results) {
  console.timeLog('trust', `storing trust for ${subName} with ${results.length} users`)
  // update the trust of each user in graph
  await models.$transaction([
    models.userSubTrust.deleteMany({
      where: {
        subName
      }
    }),
    models.userSubTrust.createMany({
      data: results
    })
  ])
}
