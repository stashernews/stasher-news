-- Keep the newest registration when an endpoint was saved more than once.
DELETE FROM "PushSubscription" older
USING "PushSubscription" newer
WHERE older.endpoint = newer.endpoint AND older.id < newer.id;

CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"(endpoint);
