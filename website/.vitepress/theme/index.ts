import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import HomePage from './HomePage.vue';
import DemoImage from './DemoImage.vue';
import DemoVideo from './DemoVideo.vue';
import TagExplorer from './TagExplorer.vue';
import ArchitectureDiagram from './ArchitectureDiagram.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('HomePage', HomePage);
    app.component('DemoImage', DemoImage);
    app.component('DemoVideo', DemoVideo);
    app.component('TagExplorer', TagExplorer);
    app.component('ArchitectureDiagram', ArchitectureDiagram);
  },
} satisfies Theme;
