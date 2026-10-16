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
      // Phone side of sketch capture (opened from the desktop's QR code).
      path: '/capture/:room',
      name: 'capture',
      component: () => import('../views/CaptureView.vue'),
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
