-- Unknown sizes remain NULL; preserve all existing export records.
ALTER TABLE `Attachment` ADD COLUMN `size` BIGINT NULL;
