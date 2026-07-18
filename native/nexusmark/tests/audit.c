#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/bpf.h>
#include <linux/keyctl.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>
#include <netinet/in.h>

static int passed;
static int failed;

static void result(const char *name, int ok, const char *detail) {
  printf("AUDIT %-30s %s %s\n", name, ok ? "PASS" : "FAIL", detail ? detail : "");
  if (ok) passed++;
  else failed++;
}

static unsigned long status_value(const char *name) {
  FILE *file = fopen("/proc/self/status", "r");
  if (!file) return ~0UL;
  char line[512];
  unsigned long value = ~0UL;
  size_t length = strlen(name);
  while (fgets(line, sizeof(line), file)) {
    if (strncmp(line, name, length) == 0 && line[length] == ':') {
      value = strtoul(line + length + 1, NULL, 16);
      break;
    }
  }
  fclose(file);
  return value;
}

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: %s <outside-secret>\n", argv[0]);
    return 64;
  }

  result("workload-not-root", getuid() != 0 && geteuid() != 0, "dedicated uid required");
  result("saved-identity-dropped", getuid() == geteuid() && getgid() == getegid(), "real/effective ids match");
  result("no-new-privileges", status_value("NoNewPrivs") == 1, "kernel status");
  result("seccomp-filter-active", status_value("Seccomp") == 2, "filter mode");
  result("capabilities-empty", status_value("CapEff") == 0, "effective capability mask");
  struct rlimit core_limit = { 1, 1 };
  int core_disabled = getrlimit(RLIMIT_CORE, &core_limit) == 0 &&
    core_limit.rlim_cur == 0 && core_limit.rlim_max == 0;
  result("core-dumps-disabled", core_disabled, "persistent zero rlimit");

  errno = 0;
  int outside = open(argv[1], O_RDONLY | O_CLOEXEC);
  result("outside-file-read-denied", outside < 0 && (errno == EACCES || errno == EPERM), strerror(errno));
  if (outside >= 0) close(outside);

  errno = 0;
  int host_process = open("/proc/1/environ", O_RDONLY | O_CLOEXEC);
  result("host-process-env-denied", host_process < 0 && (errno == EACCES || errno == EPERM), strerror(errno));
  if (host_process >= 0) close(host_process);

  errno = 0; long response = mount("none", ".", "tmpfs", 0, NULL); int saved_errno = errno;
  result("mount-denied", response < 0 && (saved_errno == EPERM || saved_errno == EACCES), strerror(saved_errno));
  errno = 0; response = syscall(SYS_unshare, CLONE_NEWNS); saved_errno = errno;
  result("namespace-create-denied", response < 0 && (saved_errno == EPERM || saved_errno == EACCES), strerror(saved_errno));
#ifdef SYS_clone
  errno = 0; response = syscall(SYS_clone, CLONE_NEWUSER | SIGCHLD, 0, 0, 0); saved_errno = errno;
  if (response == 0) _exit(91);
  if (response > 0) waitpid((pid_t)response, NULL, 0);
  result("clone-namespace-denied", response < 0 && saved_errno == EPERM, strerror(saved_errno));
#endif
#ifdef SYS_clone3
  errno = 0; response = syscall(SYS_clone3, NULL, 0); saved_errno = errno;
  result("clone3-hidden", response < 0 && saved_errno == ENOSYS, strerror(saved_errno));
#endif
  errno = 0; response = ptrace(PTRACE_ATTACH, 1, NULL, NULL); saved_errno = errno;
  result("ptrace-denied", response < 0 && (saved_errno == EPERM || saved_errno == EACCES), strerror(saved_errno));
#ifdef SYS_bpf
  errno = 0; response = syscall(SYS_bpf, BPF_MAP_CREATE, NULL, 0); saved_errno = errno;
  result("bpf-denied", response < 0 && (saved_errno == EPERM || saved_errno == EACCES), strerror(saved_errno));
#endif
#ifdef SYS_keyctl
  errno = 0; response = syscall(SYS_keyctl, KEYCTL_GET_KEYRING_ID, 0, 0); saved_errno = errno;
  result("keyring-denied", response < 0 && (saved_errno == EPERM || saved_errno == EACCES), strerror(saved_errno));
#endif
#ifdef SYS_perf_event_open
  errno = 0; response = syscall(SYS_perf_event_open, NULL, 0, -1, -1, 0); saved_errno = errno;
  result("perf-events-denied", response < 0 && (saved_errno == EPERM || saved_errno == EACCES), strerror(saved_errno));
#endif
#ifdef SYS_io_uring_setup
  errno = 0; response = syscall(SYS_io_uring_setup, 1, NULL); saved_errno = errno;
  result("io-uring-denied", response < 0 && (saved_errno == EPERM || saved_errno == EACCES), strerror(saved_errno));
#endif

  errno = 0;
  int raw = socket(AF_INET, SOCK_RAW, IPPROTO_RAW);
  result("raw-socket-denied", raw < 0 && (errno == EPERM || errno == EACCES), strerror(errno));
  if (raw >= 0) close(raw);

  const char *blocked_env[] = { "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "GCONV_PATH", "NODE_OPTIONS", "PYTHONPATH" };
  int environment_clean = 1;
  for (size_t i = 0; i < sizeof(blocked_env) / sizeof(blocked_env[0]); i++) {
    if (getenv(blocked_env[i])) environment_clean = 0;
  }
  result("loader-environment-clean", environment_clean, "dangerous inheritance removed");

  int local = open("audit-write-test", O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  int local_ok = local >= 0 && write(local, "ok\n", 3) == 3;
  if (local >= 0) close(local);
  result("server-root-write-allowed", local_ok, "workload remains functional");

  printf("AUDIT_SUMMARY passed=%d failed=%d\n", passed, failed);
  return failed ? 1 : 0;
}
