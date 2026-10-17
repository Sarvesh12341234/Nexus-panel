/*
 * ASF adversarial audit payload.
 *
 * Runs INSIDE the ASF sandbox as an unprivileged identity. It attempts a
 * series of escapes and reports PASS/FAIL for each. Any successful escape
 * exits non-zero so the audit script fails loudly.
 *
 * Usage: asf-audit <path-to-secret-outside-root>
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>
#include <netinet/in.h>

static int failures = 0;

static void result(const char *name, int blocked, const char *detail) {
  printf("  %s %s (%s)\n", blocked ? "PASS" : "FAIL", name, detail);
  if (!blocked) failures += 1;
}

int main(int argc, char **argv) {
  const char *secret = argc > 1 ? argv[1] : "/etc/shadow";

  /* 1. Reading a file outside the server root must fail. */
  int fd = open(secret, O_RDONLY);
  result("read-outside-root", fd < 0, fd < 0 ? "denied" : "READ SUCCEEDED");
  if (fd >= 0) close(fd);

  /* 2. Writing outside the server root must fail. */
  fd = open("/tmp/asf-escape-probe", O_WRONLY | O_CREAT | O_TRUNC, 0600);
  result("write-outside-root", fd < 0, fd < 0 ? "denied" : "WRITE SUCCEEDED");
  if (fd >= 0) { close(fd); unlink("/tmp/asf-escape-probe"); }

  /* 3. mount() must be denied by seccomp. */
  int rc = syscall(SYS_mount, "none", "/mnt", "tmpfs", 0, NULL);
  result("mount-denied", rc < 0, rc < 0 ? "denied" : "MOUNT SUCCEEDED");

  /* 4. ptrace must be denied. */
  rc = syscall(SYS_ptrace, 0, 0, 0, 0);
  result("ptrace-denied", rc < 0, rc < 0 ? "denied" : "PTRACE SUCCEEDED");

  /* 5. bpf() must be denied. */
  rc = syscall(SYS_bpf, 0, NULL, 0);
  result("bpf-denied", rc < 0, rc < 0 ? "denied" : "BPF SUCCEEDED");

  /* 6. unshare() must be denied (no namespace re-entry). */
  rc = syscall(SYS_unshare, 0x10000000 /* CLONE_NEWUSER */);
  result("unshare-denied", rc < 0, rc < 0 ? "denied" : "UNSHARE SUCCEEDED");

  /* 7. init_module must be denied. */
  rc = syscall(SYS_init_module, NULL, 0, "");
  result("init_module-denied", rc < 0, rc < 0 ? "denied" : "MODULE LOAD SUCCEEDED");

  /* 8. Binding a port other than the assigned one must fail (Landlock net). */
  int sock = socket(AF_INET, SOCK_STREAM, 0);
  if (sock >= 0) {
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(12345); /* not the assigned 65535 */
    rc = bind(sock, (struct sockaddr *)&addr, sizeof(addr));
    result("bind-unassigned-port", rc < 0, rc < 0 ? "denied" : "BIND SUCCEEDED");
    close(sock);
  } else {
    result("bind-unassigned-port", 1, "socket unavailable");
  }

  /* 9. no_new_privs must be set. */
  int nnp = prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0);
  result("no-new-privs", nnp == 1, nnp == 1 ? "set" : "NOT SET");

  /* 10. The process must not be root. */
  result("not-root", geteuid() != 0, geteuid() != 0 ? "unprivileged" : "STILL ROOT");

  if (failures) {
    fprintf(stderr, "ASF audit FAILED: %d escape(s) succeeded.\n", failures);
    return 1;
  }
  printf("ASF audit: all %d escape attempts blocked.\n", 10);
  return 0;
}
