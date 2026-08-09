from importlib.metadata import version

import langgraph


def main():
    print(f"LangGraph imported OK, version={version('langgraph')}")


if __name__ == "__main__":
    main()
