import type { MessageBundle } from '../../../i18n';
import type { DataCommand, DataCommandResult } from '../../../data/commands/types';
import type { WidgetHost } from '../../../contracts';

export const menuPosKo = {
  status: '판매 상태', selling: '판매 중', soldOut: '품절', options: '옵션', groupName: '묶음 이름',
  required: '필수', optional: '선택', addGroup: '옵션 묶음 추가', addOption: '옵션 추가', optionName: '옵션 이름',
  extraPrice: '추가 금액', extraRecipe: '레시피 추가량', none: '없음', photo: '메뉴 사진',
  removePhoto: '사진 빼기', noPhoto: '사진 없음', groupRequired: '필수 옵션에는 항목이 하나 이상 있어야 해요',
  groupEmpty: '옵션 묶음 이름을 넣어 주세요', optionEmpty: '옵션 이름을 넣어 주세요', amount: '0 이상의 숫자를 넣어 주세요',
  unit: '재료 단위를 확인해 주세요', invalid: '고를 수 없는 옵션이에요. 다시 골라 주세요',
} as const;
export const menuPosBundle: MessageBundle<string> = { id: 'widget.menu.pos', en: {}, 'zh-Hans': {}, 'zh-Hant': {},
  ko: Object.fromEntries(Object.entries(menuPosKo).map(([key, value]) => [`widget.menu.pos.${key}`, value])) };

export const menuPhotoBundle: MessageBundle<string> = {
  id: 'widget.menu.photo',
  ko: {
    'widget.menu.photo.label': menuPosKo.photo, 'widget.menu.photo.none': menuPosKo.noPhoto,
    'widget.menu.photo.remove': menuPosKo.removePhoto, 'widget.menu.photo.upload': '사진 올리기', 'widget.menu.photo.replace': '사진 바꾸기',
    'widget.menu.photo.custom': '내 사진', 'widget.menu.photo.uploaded': '메뉴 사진을 바꿨어요', 'widget.menu.photo.removed': '사진을 뺐어요',
    'widget.menu.photo.wrongType': 'PNG, JPEG 또는 WebP 사진을 골라 주세요',
    'widget.menu.photo.tooLarge': '5MB 이하 사진을 골라 주세요',
    'widget.menu.photo.unreadable': '사진을 열 수 없어요. 다른 사진을 골라 주세요',
  },
  en: {
    'widget.menu.photo.label': 'Menu photo', 'widget.menu.photo.none': 'No photo',
    'widget.menu.photo.remove': 'Remove photo', 'widget.menu.photo.upload': 'Upload photo', 'widget.menu.photo.replace': 'Replace photo',
    'widget.menu.photo.custom': 'My photo', 'widget.menu.photo.uploaded': 'Menu photo updated', 'widget.menu.photo.removed': 'Photo removed',
    'widget.menu.photo.wrongType': 'Choose a PNG, JPEG or WebP photo',
    'widget.menu.photo.tooLarge': 'Choose a photo up to 5 MB',
    'widget.menu.photo.unreadable': 'Couldn’t open the photo. Choose another photo',
  },
  'zh-Hans': {
    'widget.menu.photo.label': '菜单照片', 'widget.menu.photo.none': '没有照片',
    'widget.menu.photo.remove': '移除照片', 'widget.menu.photo.upload': '上传照片', 'widget.menu.photo.replace': '更换照片',
    'widget.menu.photo.custom': '我的照片', 'widget.menu.photo.uploaded': '菜单照片已更新', 'widget.menu.photo.removed': '已移除照片',
    'widget.menu.photo.wrongType': '请选择PNG、JPEG或WebP照片',
    'widget.menu.photo.tooLarge': '请选择不超过5MB的照片',
    'widget.menu.photo.unreadable': '无法打开照片，请选择其他照片',
  },
  'zh-Hant': {
    'widget.menu.photo.label': '選單照片', 'widget.menu.photo.none': '沒有照片',
    'widget.menu.photo.remove': '移除照片', 'widget.menu.photo.upload': '上傳照片', 'widget.menu.photo.replace': '更換照片',
    'widget.menu.photo.custom': '我的照片', 'widget.menu.photo.uploaded': '選單照片已更新', 'widget.menu.photo.removed': '已移除照片',
    'widget.menu.photo.wrongType': '請選擇PNG、JPEG或WebP照片',
    'widget.menu.photo.tooLarge': '請選擇不超過5MB的照片',
    'widget.menu.photo.unreadable': '無法打開照片，請選擇其他照片',
  },
};

export function menuError(result: Extract<DataCommandResult, { ok: false }>, fallback: (key: string) => string): string {
  if (result.reason === 'EMPTY_NAME') return result.field?.includes('.options.') ? menuPosKo.optionEmpty : menuPosKo.groupEmpty;
  if (result.reason === 'REQUIRED_GROUP_EMPTY') return menuPosKo.groupRequired;
  if (result.reason === 'NEGATIVE_AMOUNT') return menuPosKo.amount;
  if (result.reason === 'UNIT_MISMATCH') return menuPosKo.unit;
  if (result.reason === 'INVALID_OPTION') return menuPosKo.invalid;
  return fallback(result.messageKey);
}
const objectParticle = (name: string) => {
  const code = name.charCodeAt(name.length - 1) - 0xac00;
  return code >= 0 && code <= 11171 && code % 28 ? '을' : '를';
};
/** Reuses the root notice's existing {message} key and its single data-undo slot (R-17). */
export function reportMenuResult(host: WidgetHost, result: DataCommandResult, command: DataCommand, name: string, fallback: (key: string) => string) {
  if (!result.ok) {
    host.notify({ kind: 'error', messageKey: 'pos.notice', params: { message: menuError(result, fallback) } });
    return;
  }
  if (!result.undoToken) return;
  const message = command.type === 'menu.setSaleStatus' ? command.status === 'sold_out' ? `${name}${objectParticle(name)} 품절로 바꿨어요` : `${name}${objectParticle(name)} 다시 팔아요`
    : command.type === 'menu.setPhoto' ? fallback(command.customPhotoUrl || command.photoKey ? 'widget.menu.photo.uploaded' : 'widget.menu.photo.removed')
    : result.noticeKey === 'data.management.notice.deleted' ? '지웠어요' : '바꿨어요';
  host.notify({ kind: 'success', messageKey: 'pos.notice', params: { message }, undoToken: result.undoToken });
}
