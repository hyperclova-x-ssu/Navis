import { useBundle } from '../../../i18n';

const rows = {
  'promo.real.photoFile': ['사진 파일', 'Photo file', '照片文件', '照片檔案'],
  'promo.real.photoMenu': ['사진에 나온 메뉴', 'Menu item in the photo', '照片中的菜单项', '照片中的菜單項目'],
  'promo.real.pickMenu': ['메뉴를 골라 주세요', 'Choose a menu item', '请选择菜单项', '請選擇菜單項目'],
  'promo.real.rights': ['이 사진을 홍보에 쓸 권리가 있어요', 'I have the right to use this photo for promotion', '我有权使用这张照片作推广', '我有權使用這張照片作推廣'],
  'promo.real.upload': ['사진 올리기', 'Upload photo', '上传照片', '上傳照片'],
  'promo.real.photoSaved': ['영상에 쓸 사진을 올렸어요', 'Photo added for videos', '已上传影片用照片', '已上傳影片用照片'],
  'promo.real.saveDraft': ['초안 저장하기', 'Save draft', '保存草稿', '儲存草稿'],
  'promo.real.draftSaved': ['초안을 저장했어요', 'Draft saved', '已保存草稿', '已儲存草稿'],
  'promo.real.draftRequired': ['영상 초안을 확인해 주세요', 'Check the video draft', '请检查视频草稿', '請檢查影片草稿'],
  'promo.real.generate': ['확인하고 만들기', 'Confirm and generate', '确认并生成', '確認並生成'],
  'promo.real.oldVideo': ['아직 올리지 않은 영상이 있어요', 'You have an unposted video', '还有未发布的视频', '還有未發佈的影片'],
  'promo.real.place-news': ['플레이스 소식에 올리기', 'Post to Place news', '发布到 Place 动态', '發佈到 Place 動態'],
  'promo.real.clip': ['클립에 올리기', 'Post to Clip', '发布到 Clip', '發佈到 Clip'],
  'promo.real.placeText': ['소식 문구', 'News text', '动态文案', '動態文案'],
  'promo.real.description': ['영상 설명', 'Video description', '视频说明', '影片說明'],
  'promo.real.hashtags': ['해시태그', 'Hashtags', '话题标签', '主題標籤'],
  'promo.real.category': ['분류', 'Category', '分类', '分類'],
  'promo.real.visibility': ['공개 범위', 'Visibility', '可见范围', '可見範圍'],
  'promo.real.public': ['공개', 'Public', '公开', '公開'],
  'promo.real.private': ['비공개', 'Private', '私密', '私人'],
  'promo.real.aiUsed': ['AI로 만든 영상이에요', 'This video was generated with AI', '此视频由 AI 生成', '此影片由 AI 生成'],
  'promo.real.sponsored': ['광고·협찬 포함', 'Contains advertising or sponsorship', '包含广告或赞助', '包含廣告或贊助'],
  'promo.real.comments': ['댓글 허용', 'Allow comments', '允许评论', '允許留言'],
  'promo.real.publish': ['확인하고 올리기', 'Confirm and post', '确认并发布', '確認並發佈'],
  'promo.real.publisherPending': ['접수했어요. 게시 상태를 확인해 주세요', 'Submitted. Check publication status', '已提交，请查看发布状态', '已送出，請查看發佈狀態'],
  'promo.real.publisherDone': ['올렸어요', 'Posted', '已发布', '已發佈'],
  'promo.real.manual': ['MP4를 받은 뒤 공식 업로더에 올리고 게시 링크를 남겨 주세요', 'Download the MP4, upload it in the official uploader, then save the post link', '下载 MP4 后通过官方工具上传，再保存发布链接', '下載 MP4 後透過官方工具上傳，再儲存發佈連結'],
  'promo.real.uploader': ['공식 업로더 열기', 'Open official uploader', '打开官方上传工具', '開啟官方上傳工具'],
  'promo.real.download': ['MP4 받기', 'Download MP4', '下载 MP4', '下載 MP4'],
  'promo.real.postLink': ['게시 링크', 'Post link', '发布链接', '發佈連結'],
  'promo.real.saveLink': ['게시 링크 남기기', 'Save post link', '保存发布链接', '儲存發佈連結'],
  'promo.real.linkRequired': ['게시 링크를 입력해 주세요', 'Enter the link to the post', '请输入发布链接', '請輸入發佈連結'],
  'promo.real.linkCheck': ['선택한 채널에 이 영상을 직접 올렸나요?', 'Did you post this video on the selected channel?', '您是否已在所选渠道发布此视频？', '您是否已在所選管道發佈此影片？'],
  'promo.real.extra': ['한 번 더 확인', 'Confirm again', '再次确认', '再次確認'],
  'promo.real.linkSaved': ['게시 링크를 남겼어요', 'Post link saved', '已保存发布链接', '已儲存發佈連結'],
  'promo.real.error': ['작업을 마치지 못했어요. 다시 시도해 주세요', 'Could not finish. Please try again', '未能完成，请重试', '未能完成，請再試一次'],
} as const;

const messages = (index: 0 | 1 | 2 | 3) => Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, value[index]]));
export const promoRealBundle = { id: 'promo-real', ko: messages(0), en: messages(1), 'zh-Hans': messages(2), 'zh-Hant': messages(3) };
export const usePromoRealText = () => useBundle(promoRealBundle);
