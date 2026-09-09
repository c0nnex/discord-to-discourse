CREATE TABLE `TopicExportState` (
 `topicId` VARCHAR(191) NOT NULL,
 `lastMessageId` VARCHAR(191) NOT NULL DEFAULT '0',
 `scanBeforeId` VARCHAR(191) NULL,
 `scanHighId` VARCHAR(191) NULL,
 PRIMARY KEY (`topicId`),
 CONSTRAINT `TopicExportState_topicId_fkey` FOREIGN KEY (`topicId`) REFERENCES `Topic` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
