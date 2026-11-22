-- Up Migration
ALTER TABLE marketing.notice_reply_approval DROP CONSTRAINT notice_reply_approval_operation_check;
ALTER TABLE marketing.notice_reply_approval ADD CHECK (operation IN
  ('inquiry.attest','inquiry.post','inquiry.editReply','inquiry.deleteReply',
   'notice.attest','notice.deleteDraft','notice.send','notice.deleteNews','notice.cancelSms'));

-- Down Migration
ALTER TABLE marketing.notice_reply_approval DROP CONSTRAINT notice_reply_approval_operation_check;
ALTER TABLE marketing.notice_reply_approval ADD CHECK (operation IN
  ('inquiry.attest','inquiry.post','inquiry.editReply','inquiry.deleteReply',
   'notice.attest','notice.deleteDraft','notice.send','notice.deleteNews')) NOT VALID;
