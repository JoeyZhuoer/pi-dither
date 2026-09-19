import { VERSION, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { installWorkstation } from '../src/workstation.mjs';

export default function workstation(pi: ExtensionAPI) {
  installWorkstation(pi, { version: VERSION, truncateToWidth, visibleWidth });
}
