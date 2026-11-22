/** CLOVA Speech short-sentence mode without pronunciation scoring or graphs.
 * https://api.ncloud-docs.com/docs/ai-application-service-clovaspeech-shortsentence
 */
export interface ShortSpeechResult {
  text: string;
  quota: number;
}

/** CLOVA Document OCR Receipt V2. Multipart carries this metadata in message
 * and supplies file bytes separately.
 * https://api.ncloud-docs.com/docs/ai-application-service-ocr-ocrdocumentocr-receipt
 */
export interface ReceiptImageSpec {
  format: 'jpg' | 'jpeg' | 'png' | 'pdf' | 'tif' | 'tiff';
  name: string;
  data?: string;
}

export interface ReceiptRequest {
  version: 'V2';
  requestId: string;
  timestamp: number;
  images: ReceiptImageSpec[];
}

interface Recognition<Value> {
  text: string;
  formatted: Value;
  confidenceScore: number;
}

type Value = { value: string };

export interface ReceiptData {
  storeInfo: { name: Recognition<Value> };
  paymentInfo: { date: Recognition<{ year: string; month: string; day: string }> };
  totalPrice: { price: Recognition<Value> };
  subResults: { items: {
    name: Recognition<Value>;
    count: Recognition<Value>;
    price: { price: Recognition<Value>; unitPrice: Recognition<Value> };
  }[] }[];
}

export interface ReceiptImageResult {
  uid: string;
  name: string;
  inferResult: 'SUCCESS' | 'FAILURE' | 'ERROR';
  message: string;
  validationResult: { result: 'NO_REQUESTED' };
  receipt?: { meta: { estimatedLanguage: 'ko' }; result: ReceiptData };
}

export interface ReceiptResponse extends Omit<ReceiptRequest, 'images'> {
  images: ReceiptImageResult[];
}
