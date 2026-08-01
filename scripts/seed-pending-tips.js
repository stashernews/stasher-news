const { PrismaClient } = require('@prisma/client')

// Seed N PENDING ObservedTips against one author account + post for the webhook load test.
// The tips are PENDING (no webhook actually registered — the load test drives the receiver
// directly with synthetic 0-conf payloads). Run inside the app container:
//   docker exec -u apprunner app node scripts/seed-pending-tips.js 500
//
// NOTE: uses require() (not `import`) so plain `node` runs it — package.json has no
// "type": "module", so an ESM `import` in a .js file is a SyntaxError under plain node.
async function main () {
  const N = Number(process.argv[2] || 500)
  const prisma = new PrismaClient()
  // Reuse one author user + account + post if already seeded, else create them.
  let author = await prisma.user.findFirst({ where: { name: 'loadtest_author' } })
  if (!author) author = await prisma.user.create({ data: { name: 'loadtest_author', createdAt: new Date() } })
  let account = await prisma.moneroAccount.findFirst({ where: { ownerUserId: author.id } })
  if (!account) {
    account = await prisma.moneroAccount.create({
      data: { ownerUserId: author.id, address: '54' + '0'.repeat(91), label: 'loadtest', network: 'STAGENET', status: 'ACTIVE' }
    })
  }
  let post = await prisma.item.findFirst({ where: { userId: author.id, title: 'loadtest post' } })
  if (!post) {
    post = await prisma.item.create({
      data: { userId: author.id, title: 'loadtest post', parentId: null, createdAt: new Date() }
    })
  }
  const amount = 1000000000n // 0.001 XMR
  for (let i = 0; i < N; i++) {
    const paymentId = (i.toString(16).padStart(16, '0')).slice(0, 16)
    await prisma.observedTip.create({
      data: {
        txHash: 'pending-' + paymentId,
        postId: post.id,
        tipperId: null,
        recipientAccountId: account.id,
        recipientMajor: null,
        recipientMinor: null,
        paymentId,
        piconeros: amount,
        height: null,
        state: 'PENDING',
        proofType: 'INDEXED'
      }
    })
  }
  console.log(`seeded ${N} PENDING tips on post ${post.id} (account ${account.id})`)
  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
