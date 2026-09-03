import { createRouter, createWebHistory } from 'vue-router'
import CanvasView from '../views/CanvasView.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'canvas',
      component: CanvasView,
      // Also reachable at /canvas.
      alias: '/canvas',
    },
    {
      path: '/about',
      name: 'about',
      // route level code-splitting
      component: () => import('../views/AboutView.vue'),
    },
  ],
})

export default router
