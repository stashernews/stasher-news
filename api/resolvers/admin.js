async function readAnnouncement (models) {
  const snl = await models.snl.findFirst({ orderBy: { id: 'asc' } })
  return snl?.live && snl.message ? snl.message : null
}

export default {
  Query: {
    announcement: async (parent, _, { models }) => await readAnnouncement(models),
    snl: async (parent, _, { models }) => (await readAnnouncement(models)) != null
  }
}
