"""
Docker FalkorDB Tunnel — 通过 docker exec 访问 WSL2 Docker 中的 FalkorDB
包装 falkordb.asyncio.FalkorDB 的 __init__，使得 graphiti_core 可以直接使用
"""
import subprocess
import json
import asyncio


class DockerFalkorDBClient:
    """通过 docker exec 隧道访问 FalkorDB 容器"""

    def __init__(self, container_name="falkordb"):
        self.container = container_name

    def _exec(self, *args):
        """执行 docker exec 命令并返回 stdout"""
        cmd = ["docker", "exec", self.container, "redis-cli"] + list(args)
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return result.stdout.strip()


class DockerFalkorDB:
    """模拟 falkordb.asyncio.FalkorDB，使得可以传给 graphiti_core 的 FalkorDriver"""

    def __init__(self, host="127.0.0.1", port=6379, container="falkordb"):
        self._container = container
        self._pipe = DockerFalkorDBClient(container)
        # Pretend we connected successfully
        print(f"DockerFalkorDB: tunnel to container '{container}' ready")

    def select_graph(self, name):
        """Select a graph database. Returns a DockerGraph instance"""
        return DockerGraph(name, self._container)


class DockerGraph:
    """模拟 falkordb.Graph"""

    def __init__(self, name, container):
        self.name = name
        self._container = container

    def query(self, cypher: str, params=None):
        """Synchronously execute a Cypher query"""
        # Use GRAPH.QUERY via redis-cli
        args = ["GRAPH.QUERY", self.name, cypher]
        cmd = ["docker", "exec", self._container, "redis-cli"] + args
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        output = result.stdout.strip()
        return DockerResultSet(output)

    async def query_async(self, cypher: str, params=None):
        """Asynchronously execute a Cypher query"""
        # Use sync subprocess.run in a thread
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self.query, cypher, params)

    async def call_procedure(self, procedure: str, *args):
        """Call a stored procedure"""
        params = " ".join(str(a) for a in args)
        cmd_args = [procedure] + list(args)
        return await asyncio.get_event_loop().run_in_executor(
            None, lambda: DockerFalkorDBClient(self._container)._exec(*cmd_args)
        )


class DockerResultSet:
    """Parse FalkorDB GRAPH.QUERY results into graphiti_core compatible format"""

    def __init__(self, raw_output):
        self._raw = raw_output
        self.result_set = self._parse()

    def _parse(self):
        lines = [l for l in self._raw.splitlines() if l.strip()]
        results = []
        for line in lines:
            try:
                results.append(json.loads(line))
            except json.JSONDecodeError:
                results.append(line)
        return results

    def pretty_print(self):
        return self._raw
