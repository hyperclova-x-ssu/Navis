// Published SENS request and result fields for the selected SMS/LMS, Mail and Biz Message modes.
// https://api.ncloud-docs.com/docs/sens-sms-send
// https://api.ncloud-docs.com/docs/sens-alimtalk-send
// https://api.ncloud-docs.com/docs/sens-brandmessage-send
// https://api.ncloud-docs.com/docs/sens-mail-request-create
export type SensProduct = 'sms' | 'alimtalk' | 'brandmessage' | 'mail';

interface Schedule {
  reserveTime?: string;
  reserveTimeZone?: string;
}

export type SmsRequest = Schedule & {
  type: 'SMS' | 'LMS';
  contentType?: 'COMM' | 'AD';
  countryCode?: string;
  from: string;
  subject?: string;
  content: string;
  messages: { to: string; subject?: string; content?: string }[];
};

export type AlimTalkRequest = Schedule & {
  plusFriendId: string;
  templateCode: string;
  messages: { countryCode?: string; to: string; content: string; useSmsFailover?: false }[];
};

export type BrandTarget = 'M' | 'N' | 'I';
export type BrandMessageRequest = Schedule & {
  plusFriendId: string;
  messageType: 'TEXT';
  targeting?: BrandTarget;
  isAdult?: boolean;
} & (
  { messages: { countryCode?: string; to: string; content: string; useSmsFailover?: false }[] }
  | { templateCode: string; messages: { countryCode?: string; to: string; templateParameters: Record<string, string>; useSmsFailover?: false }[] }
);

export type MailRecipient = { address: string; name?: string; type?: 'TO' | 'CC' | 'BCC'; parameters?: Record<string, string> };
export interface MailRequest {
  senderAddress: string;
  senderName?: string;
  title: string;
  body: string;
  recipients: MailRecipient[];
  parameters?: Record<string, string>;
  individual?: boolean;
  confirmAndSend?: boolean;
  advertising?: false;
  reservationDateTime?: string;
}

export interface MessageAcceptance {
  requestId: string;
  requestTime: string;
  statusCode: '202';
  statusName: 'success' | 'processing' | 'reserved';
}

export interface BizMessageAcceptedRecipient {
  messageId: string;
  countryCode: string;
  to: string;
  requestStatusCode: string;
  requestStatusName: 'success' | 'fail';
  requestStatusDesc: string;
  useSmsFailover: boolean;
}

export type BizAcceptance = MessageAcceptance & { messages?: (BizMessageAcceptedRecipient & { content?: string })[] };

// https://api.ncloud-docs.com/docs/sens-sms-get
export interface SmsResultMessage {
  requestId: string;
  messageId: string;
  requestTime: string;
  contentType: 'COMM' | 'AD';
  type: 'SMS' | 'LMS';
  subject?: string;
  content?: string;
  countryCode: string;
  from: string;
  to: string;
  status: 'READY' | 'PROCESSING' | 'COMPLETED';
  completeTime?: string;
  telcoCode?: string;
  statusCode?: string;
  statusName?: 'success' | 'fail';
  statusMessage?: string;
}

export type SmsResult = { statusCode: '200'; statusName: 'success' | 'reserved' | 'fail'; messages: SmsResultMessage[] };

// https://api.ncloud-docs.com/docs/sens-alimtalk-get
// https://api.ncloud-docs.com/docs/sens-brandmessage-get
type BizDelivery = BizMessageAcceptedRecipient & {
  requestId: string;
  requestTime: string;
  plusFriendId: string;
  content: string;
  completeTime?: string;
  messageStatusCode?: string;
  messageStatusName: 'success' | 'processing' | 'fail';
  messageStatusDesc?: string;
};

export type AlimTalkResult = BizDelivery & { templateCode: string };
export type BrandMessageResult = BizDelivery & {
  messageType: 'TEXT';
  targeting: BrandTarget;
  isAdult: boolean;
  templateCode?: string;
  templateParameters?: Record<string, string>;
};
export type MessageList<Message> = {
  statusCode: '202';
  statusName: MessageAcceptance['statusName'] | 'fail';
  requestId?: string;
  messages: Message[];
  pageSize: number;
  pageIndex: number;
  itemCount: number;
  hasMore: boolean;
  nextToken?: string;
};

export interface MailAcceptance {
  requestId: string;
  requestCount: number;
  createDateTime: string;
}

export interface MailRequestResult extends MailAcceptance {
  status: 'READY' | 'RESERVED' | 'COMPLETED' | 'FAILED' | 'PARTIAL_FAILED';
  readyCount: number;
  sentCount: number;
  finishCount: number;
  reservationDateTime: string | null;
  countsByStatus: { status: 'READY' | 'RESERVED' | 'COMPLETED' | 'FAILED'; count: number }[];
}

// https://api.ncloud-docs.com/docs/sens-mail-get
export interface MailResult {
  requestId: string;
  mailId: string;
  requesterIp: string;
  createDateTime: string;
  title: string;
  templateNo: number | null;
  templateName: string | null;
  status: MailRequestResult['status'];
  senderAddress: string;
  senderName: string | null;
  sendDateTime: string | null;
  reservationDateTime: string | null;
  body: string;
  advertising: boolean;
  attachFiles: { fileId: string; fileName: string; fileSize: number }[];
  recipients: {
    address: string;
    name: string | null;
    type: 'TO' | 'CC' | 'BCC';
    received: boolean;
    receivedDateTime: string | null;
    status: 'READY' | 'RESERVED' | 'COMPLETED' | 'FAILED';
    retryCount: number;
    sendResultCode?: string;
    sendResultMessage?: string;
  }[];
}

export type MailError = { error: { errorCode: string; message: string } };
export type SensError = { status: number; error: string; message: string };


// https://api.ncloud-docs.com/docs/sens-sms-reservation-status-get
export type SmsReservationStatus = 'READY' | 'PROCESSING' | 'CANCELED' | 'FAIL' | 'DONE' | 'STALE' | 'SKIP';
export type SmsReservation = {
  reserveId: string; reserveTimeZone: string; reserveTime: string; reserveStatus: SmsReservationStatus;
};
