<script setup lang="ts">
import { RouterView } from "vue-router";
import { ToastHost, ConfirmHost } from "./shared/ui";
</script>

<template>
  <div class="soc-shell" style="height: 100vh; display: flex; flex-direction: column; overflow: hidden">
    <RouterView />
    <ToastHost />
    <ConfirmHost />
  </div>
</template>
