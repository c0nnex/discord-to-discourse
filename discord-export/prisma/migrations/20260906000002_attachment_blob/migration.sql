CREATE TABLE `AttachmentBlob` (
    `attachmentId` VARCHAR(191) NOT NULL,
    `content` LONGBLOB NOT NULL,
    `sha256` CHAR(64) NOT NULL,
    `downloadedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`attachmentId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `AttachmentBlob` ADD CONSTRAINT `AttachmentBlob_attachmentId_fkey`
FOREIGN KEY (`attachmentId`) REFERENCES `Attachment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
