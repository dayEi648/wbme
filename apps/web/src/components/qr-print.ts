/**
 * 将二维码打印内容安全写入新窗口。
 *
 * @param document 新窗口的 document 对象
 * @param label 二维码的人类可读名称
 * @param imageDataUrl 由本地二维码 canvas 生成的 data URL
 * @returns 已插入文档的二维码图片元素
 */
export function populateQrPrintDocument(document: Document, label: string, imageDataUrl: string): HTMLImageElement {
  document.title = '打印二维码';
  document.body.replaceChildren();
  document.body.style.cssText = 'text-align:center;font-family:sans-serif';

  const heading = document.createElement('h3');
  heading.textContent = label;

  const image = document.createElement('img');
  image.src = imageDataUrl;
  image.alt = '二维码';
  image.style.width = '280px';
  image.style.height = '280px';

  document.body.append(heading, image);
  return image;
}

/**
 * 打开二维码打印窗口并在图片加载后调用浏览器打印能力。
 *
 * @param label 二维码的人类可读名称
 * @param imageDataUrl 由本地二维码 canvas 生成的 data URL
 * @returns 无法打开弹窗时返回 false，否则返回 true
 */
export function openQrPrintWindow(label: string, imageDataUrl: string): boolean {
  const printWindow = window.open('', '_blank');
  if (!printWindow) return false;

  try {
    printWindow.opener = null;
  } catch {
    // 跨浏览器限制下无法重设 opener 不影响安全的 DOM 构建与打印流程。
  }

  const image = populateQrPrintDocument(printWindow.document, label, imageDataUrl);
  let printed = false;
  const print = () => {
    if (printed) return;
    printed = true;
    printWindow.focus();
    printWindow.print();
  };
  image.addEventListener('load', print, { once: true });
  if (image.complete) {
    queueMicrotask(print);
  }
  return true;
}
