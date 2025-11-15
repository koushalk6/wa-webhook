FROM python:3.10-slim

RUN apt-get update && apt-get install -y \
    ffmpeg libavcodec-extra libavdevice-dev libavfilter-dev libavformat-dev \
    libavutil-dev libswresample-dev libswscale-dev && \
    apt-get clean

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY python_service.py .

CMD ["python", "python_service.py"]
