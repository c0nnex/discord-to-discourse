-- Preserve existing values; refreshAttachments repairs truncated or expired URLs.
ALTER TABLE `Attachment` MODIFY `url` TEXT NOT NULL;
