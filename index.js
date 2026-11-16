// 随剧听（ST-Music）入口：初始化各模块。

import { settings } from './src/settings.js';
import { preconnect } from './src/sources.js';
import * as player from './src/player.js';
import * as ui from './src/ui.js';
import * as rec from './src/rec.js';
import * as media from './src/media.js';
import { mountExtensionPage } from './src/settingsUi.js';

function start() {
    settings();
    preconnect();
    ui.init();
    media.init();
    player.init();
    rec.init();
    mountExtensionPage();
}

if (globalThis.jQuery) globalThis.jQuery(start); else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
