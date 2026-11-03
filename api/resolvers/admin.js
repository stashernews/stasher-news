export default {
  Query: {
    snl: async (parent, _, { models }) => {
      const snl = await models.snl.findFirst()
      return !!snl?.live
    }
  }
}
