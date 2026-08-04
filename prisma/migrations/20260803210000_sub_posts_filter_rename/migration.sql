-- Rename Sub.postsSatsFilter to the piconeros vocabulary (GraphQL/resolvers already renamed).
ALTER TABLE "Sub" RENAME COLUMN "postsSatsFilter" TO "postsPiconerosFilter";
