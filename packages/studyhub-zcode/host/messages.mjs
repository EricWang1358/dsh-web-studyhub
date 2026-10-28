/* What the ZCode host says on its own account (its own actions: the library folder, the model endpoint, opening links),
   in the panel's language. Errors from a model call inside StudyHub's work go through lib/application-messages.js like
   every other application message, because the work does not know the panel's language. */

const TEXT = Object.freeze({
  'library-not-absolute': ['请填写学习库的完整路径（例如 D:\\StudyHub）', 'Enter the full path of the library folder (for example D:\\StudyHub)'],
  'model-url-invalid': ['接口地址不是一个网址，请以 https:// 开头', 'The address is not a web address; start it with https://'],
  'model-incomplete': ['还缺接口地址、模型或 API Key，填好保存后再测试', 'The address, the model or the API key is missing; fill them in and save, then test'],
  'model-test-ok': ['可用：接口、模型和密钥都通了', 'Works: the address, the model and the key all answered'],
  'link-refused': ['只能打开正常的 http(s) 网址', 'Only an ordinary http(s) web address can be opened'],
  'update-no-installer': ['ZCode 版不能在应用内升级，请按升级说明下载新的 ZCode 安装包', 'The ZCode edition cannot upgrade itself; download the new ZCode package as the upgrade steps say'],
  'panel-open-unavailable': ['ZCode 版的面板不能被主会话打开题目；请让学习者在面板里点开', 'In ZCode the chat cannot open a question in the panel; ask the learner to open it there'],
});

export const zcodeText = (code, language = 'zh') => {
  const pair = TEXT[code];
  return pair ? pair[language === 'en' ? 1 : 0] : code;
};

/** An error that carries its code; the host turns it into words in the panel's language. */
export const zcodeError = (code) => Object.assign(new Error(zcodeText(code)), { code: `zcode-${code}` });

/** The words of an error from this host in `language`; other errors keep their own message. */
export const zcodeErrorText = (error, language) => (typeof error?.code === 'string' && error.code.startsWith('zcode-')
  ? zcodeText(error.code.slice(6), language) : String(error?.message ?? error));

export const ZCODE_MESSAGE_CODES = Object.freeze(Object.keys(TEXT));
