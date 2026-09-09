-- Preserve the populated export; NULL checked timestamp identifies legacy rows.
-- Targets deliberately have no foreign keys: they may be outside this export.
ALTER TABLE `Post`
    ADD COLUMN `messageType` INTEGER NULL,
    ADD COLUMN `referenceType` INTEGER NULL,
    ADD COLUMN `referenceMessageId` VARCHAR(191) NULL,
    ADD COLUMN `referenceChannelId` VARCHAR(191) NULL,
    ADD COLUMN `referenceGuildId` VARCHAR(191) NULL,
    ADD COLUMN `referencedMessageDeleted` BOOLEAN NULL,
    ADD COLUMN `referenceCheckedAt` DATETIME(3) NULL;
CREATE INDEX `Post_referenceCheckedAt_id_idx` ON `Post`(`referenceCheckedAt`, `id`);
