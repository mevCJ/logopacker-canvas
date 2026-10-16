import { fileURLToPath, URL } from 'node:url'
import { networkInterfaces } from 'node:os'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

import { cloudflare } from "@cloudflare/vite-plugin"

// First private IPv4 address of this machine. In dev, a phone can't open the
// desktop's "localhost", so the phone-capture QR code points here instead
// (requires `npm run dev:lan`, which listens on the network).
function lanHost(): string {
	for (const list of Object.values(networkInterfaces())) {
		for (const a of list ?? []) {
			if (a.family === 'IPv4' && !a.internal) return a.address
		}
	}
	return ''
}

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
	define: {
		__DEV_LAN_HOST__: JSON.stringify(command === 'serve' ? lanHost() : ''),
	},
	plugins: [
		vue(),
		vueDevTools(),
		cloudflare()
	],
	resolve: {
		alias: {
			'@': fileURLToPath(new URL('./src', import.meta.url))
		},
	},
}))
