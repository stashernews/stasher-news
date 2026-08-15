const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

function selectRandomly (items) {
  return items[Math.floor(Math.random() * items.length)]
}

async function addComments (parentIds, nComments, userIds, commentText) {
  const clonedParentIds = [...parentIds]
  const clonedUserIds = [...userIds]
  for (let i = 0; i < nComments; i++) {
    const selectedParent = selectRandomly(clonedParentIds)
    const selectedUserId = selectRandomly(clonedUserIds)
    const newComment = await prisma.item.create({
      data: {
        parentId: selectedParent,
        userId: selectedUserId,
        text: commentText
      }
    })
    clonedParentIds.push(newComment.id)
  }
}

async function main () {
  // StasherNews: ensure the PlatformFeeConfig singleton exists (id=1) with schema
  // defaults. All fee/tip code reads minTipPiconeros, postingFeeFloorPiconeros, etc.
  // from this row; without it they would null-deref.
  await prisma.platformFeeConfig.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 }
  })

  const stasher = await prisma.user.upsert({
    where: { name: 'stasher' },
    update: {},
    create: {
      name: 'stasher'
    }
  })
  const satoshi = await prisma.user.upsert({
    where: { name: 'satoshi' },
    update: {},
    create: {
      name: 'satoshi'
    }
  })
  const greg = await prisma.user.upsert({
    where: { name: 'greg' },
    update: {},
    create: {
      name: 'greg'
    }
  })
  const stan = await prisma.user.upsert({
    where: { name: 'stan' },
    update: {},
    create: {
      name: 'stan'
    }
  })
  // id 27 per USER_ID.anon (lib/constants.js); normally already seeded by the
  // 20260821000000_seed_anon_user migration — the upsert is a safety net for
  // fresh databases seeded before migrations run.
  const anon = await prisma.user.upsert({
    where: { name: 'anon' },
    update: {},
    create: {
      name: 'anon'
    }
  })

  // 'ad' is the ads bot account. Unlike anon there is no migration seeding
  // it — the dev DB has it from legacy data, but a fresh CI database does
  // not, and the ad-post create below null-derefs without it. Upsert keeps
  // re-seeding a dev DB a no-op while making fresh-DB seeding self-contained.
  const ad = await prisma.user.upsert({
    where: { name: 'ad' },
    update: {},
    create: {
      name: 'ad'
    }
  })

  await prisma.item.create({
    data: {
      title: 'System76 Developing “Cosmic” Desktop Environment',
      url: 'https://blog.system76.com/post/648371526931038208/cosmic-to-arrive-in-june-release-of-popos-2104',
      userId: satoshi.id,
      subName: 'bitcoin',
      children: {
        create: {
          userId: stasher.id,
          text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
          children: {
            create: {
              userId: satoshi.id,
              text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
              children: {
                create: {
                  userId: greg.id,
                  text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.'
                }
              }
            }
          }
        }
      }
    }
  })

  await prisma.item.create({
    data: {
      title: 'Deno 1.9',
      url: 'https://deno.com/blog/v1.9',
      userId: stasher.id,
      subName: 'bitcoin',
      children: {
        create: {
          userId: satoshi.id,
          text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
          children: {
            create: {
              userId: stasher.id,
              text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
              children: {
                create: {
                  userId: stan.id,
                  text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.'
                }
              }
            }
          }
        }
      }
    }
  })

  await prisma.item.create({
    data: {
      title: '1Password Secrets Automation',
      url: 'https://blog.1password.com/introducing-secrets-automation/',
      userId: greg.id,
      subName: 'bitcoin',
      children: {
        create: {
          userId: stasher.id,
          text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
          children: {
            create: {
              userId: satoshi.id,
              text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
              children: {
                create: {
                  userId: greg.id,
                  text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.'
                }
              }
            }
          }
        }
      }
    }
  })

  await prisma.item.create({
    data: {
      title: '‘Counter Strike’ Bug Allows Hackers to Take over a PC with a Steam Invite',
      url: 'https://www.vice.com/en/article/dyvgej/counter-strike-bug-allows-hackers-to-take-over-a-pc-with-a-steam-invite',
      userId: stan.id,
      subName: 'bitcoin',
      children: {
        create: {
          userId: greg.id,
          text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
          children: {
            create: {
              userId: stan.id,
              text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
              children: {
                create: {
                  userId: stasher.id,
                  text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.'
                }
              }
            }
          }
        }
      }
    }
  })

  await prisma.item.create({
    data: {
      title: 'An anonymous post',
      url: 'https://www.google.com',
      userId: anon.id,
      subName: 'bitcoin',
      children: {
        create: {
          userId: anon.id,
          text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.'
        }
      }
    }
  })

  await prisma.item.create({
    data: {
      title: 'An ad post',
      url: 'https://www.google.com',
      userId: ad.id,
      subName: 'bitcoin',
      children: {
        create: {
          userId: anon.id,
          text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.'
        }
      }
    }
  })

  const bigCommentPost = await prisma.item.create({
    data: {
      title: 'a discussion post with a lot of comments',
      text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
      userId: stasher.id,
      subName: 'bitcoin'
    }
  })

  // awaited: fire-and-forget here raced main()'s finally($disconnect) against the
  // 200 in-flight comment inserts — prisma's disconnect-retry then produced phantom
  // unique-(id) violations (nondeterministic seed failures on fresh databases)
  await addComments([bigCommentPost.id], 200, [stasher.id, anon.id, satoshi.id, greg.id, stan.id], 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.')

  // Migrations seed fixed-id rows (users 27=anon, 616=stasher, ...) with
  // explicit ids, which does NOT advance the id sequences. On a fresh
  // database the serial then hands out already-taken ids (first collision:
  // users id 27) and any serial-assigned insert fails with 23505. Resync
  // each table's `<table>_id_seq` to MAX(id) so fresh-DB inserts work. (Dev
  // databases get this implicitly from organic insert traffic over time.)
  // Identifiers come from the pg_tables catalog (not user input) and are
  // quoted; tables without the sequence or an id column are skipped.
  const tables = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  for (const { tablename } of tables) {
    const safe = tablename.replace(/"/g, '""')
    await prisma.$executeRawUnsafe(
      `SELECT setval('"${safe}_id_seq"', (SELECT MAX(id) FROM "${safe}"))`
    ).catch(() => {}) // no <table>_id_seq or no id column — nothing to resync
  }
}
main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
