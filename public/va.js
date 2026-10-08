// Vercel Web Analytics: queues calls made before the script itself has loaded.
// In a file rather than inline because the Content-Security-Policy in
// vercel.json allows scripts from this origin only, and blocked the inline copy.
window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
