.PHONY: test offline compile verify

PY ?= python
LOCAL_ENV = APP_ENV=local AI_PROVIDER=rules PYTHON_DOTENV_DISABLED=1

test:
	$(LOCAL_ENV) $(PY) -m pytest -q

offline:
	$(LOCAL_ENV) $(PY) -m app.offline_demo --evaluate

compile:
	$(LOCAL_ENV) $(PY) -m compileall -q app main.py tools

verify: compile test offline
