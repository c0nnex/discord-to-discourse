-- Additive: preserve exported messages, attachments, blobs and cursors.
ALTER TABLE `Post` ADD COLUMN `embeds` JSON NULL,
    ADD COLUMN `embedsCheckedAt` DATETIME(3) NULL;
ALTER TABLE `Category` ADD COLUMN `exportEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `exportSince` DATETIME(3) NULL,
    ADD COLUMN `exportCheckedAt` DATETIME(3) NULL;
ALTER TABLE `TopicExportState` ADD COLUMN `exportFromId` VARCHAR(191) NOT NULL DEFAULT '0';
CREATE TABLE `ExportControl` (
    `key` VARCHAR(191) NOT NULL,
    `value` TEXT NOT NULL,
    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- Empty value disables the role marker; operators configure their own role ID.
INSERT INTO `ExportControl` (`key`, `value`) VALUES ('NoExportRoleId', '');
CREATE INDEX `Post_embedsCheckedAt_id_idx` ON `Post` (`embedsCheckedAt`, `id`);
