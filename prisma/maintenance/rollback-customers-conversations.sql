-- Rollback for migration 20261107094154_add_customers_conversations.
--
-- Removes the Customer, Conversation and Message tables and their enums, and
-- the migration's history row, so the database matches main again and a later
-- `prisma migrate deploy` applies the migration from scratch.
--
-- Use it only:
--   * after the application has been redeployed WITHOUT this feature, and
--   * after a backup, agreed with the team (Shrouq), never on your own.
-- It refuses to run while any customer exists, because that is real chat
-- history; restore the backup instead in that case.
--
-- One DO block = one statement, so it is all-or-nothing in psql, pg and
-- `prisma db execute`. Safe to run twice, and also after a half-applied deploy.
DO $$
BEGIN
  IF to_regclass('public."Customer"') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM "Customer") THEN
      RAISE EXCEPTION 'Refusing to roll back: customers exist. Restore a backup instead.';
    END IF;
  END IF;

  DROP TABLE IF EXISTS "Message";
  DROP TABLE IF EXISTS "Conversation";
  DROP TABLE IF EXISTS "Customer";

  DROP TYPE IF EXISTS "MessageDeliveryStatus";
  DROP TYPE IF EXISTS "MessageType";
  DROP TYPE IF EXISTS "MessageSenderType";
  DROP TYPE IF EXISTS "ConversationStatus";
  DROP TYPE IF EXISTS "ConversationChannel";

  DELETE FROM "_prisma_migrations"
  WHERE migration_name = '20261107094154_add_customers_conversations';
END $$;
